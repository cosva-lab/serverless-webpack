'use strict';

const fs = require('fs');
const path = require('path');
const BbPromise = require('bluebird');
const glob = require('glob');
const _ = require('lodash');
const archiver = require('archiver');
const semver = require('semver');
const { getAllNodeFunctions, isProviderGoogle } = require('./utils');

function setArtifactPath(funcName, func, artifactPath) {
  const version = this.serverless.getVersion();

  if (this.log) {
    this.log.verbose(`Setting artifact for function '${funcName}' to '${artifactPath}'`);
  } else {
    this.options.verbose && this.serverless.cli.log(`Setting artifact for function '${funcName}' to '${artifactPath}'`);
  }

  // Serverless changed the artifact path location in version 1.18
  if (semver.lt(version, '1.18.0')) {
    func.artifact = artifactPath;
    func.package = _.assign({}, func.package, { disable: true });
    if (!this.log) {
      this.serverless.cli.log(`${funcName} is packaged by the webpack plugin. Ignore messages from SLS.`);
    }
  } else {
    func.package = {
      artifact: artifactPath
    };
  }
}

async function serverlessZip({ artifactFilePath, directory, files }) {
  const archive = archiver('zip', { zlib: { level: 4 } });
  const stream = fs.createWriteStream(artifactFilePath);
  const total = files.length;
  archive
    .directory(directory, false)
    .on('error', err => {
      throw err;
    })
    .on('progress', progress => {
      const { processed } = progress.entries;
      if (processed >= total) console.log(`\n${processed}/${total} files processed`);
    })
    .pipe(stream);
  await archive.finalize();
  await new Promise(resolve => stream.on('close', resolve));
  return artifactFilePath;
}

async function zip(directory, zipFileName) {
  // Check that files exist to be zipped
  const files = glob.sync('**', {
    cwd: directory,
    dot: true,
    silent: true,
    follow: true,
    nodir: true
  });

  // if excludeRegex option is defined, we'll have to list all files to be zipped
  // and then force the node way to zip to avoid hitting the arguments limit (ie: E2BIG)
  // when using the native way (ie: the zip command)
  const { excludeRegex } = this.configuration;
  if (excludeRegex) {
    /**
     * @type {Set<string>}
     */
    let filesExcluded = 0;
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (file.match(excludeRegex)) {
        files.splice(index, 1);
        filesExcluded++;
        const pathFile = path.join(directory, file);
        if (fs.existsSync(pathFile)) fs.unlinkSync(pathFile, { recursive: true });
        index--;
      }
    }

    if (this.log) {
      this.log.verbose(`Excluded ${filesExcluded} file(s) based on excludeRegex`);
    } else {
      this.options.verbose && this.serverless.cli.log(`Excluded ${filesExcluded} file(s) based on excludeRegex`);
    }
  }

  if (_.isEmpty(files)) {
    const error = new this.serverless.classes.Error('Packaging: No files found');
    throw error;
  }

  // Create artifact in temp path and move it to the package path (if any) later
  // This allows us to persist the webpackOutputPath and re-use the compiled output
  const artifactFilePath = path.join(this.webpackOutputPath, zipFileName);
  this.serverless.utils.writeFileDir(artifactFilePath);

  return serverlessZip.call(this, {
    directory,
    artifactFilePath,
    files
  });
}

function getArtifactLocations(name) {
  const archiveName = `${name}.zip`;

  const webpackArtifact = path.join(this.webpackOutputPath, archiveName);
  const serverlessArtifact = path.join('.serverless', archiveName);

  return { webpackArtifact, serverlessArtifact };
}

function copyArtifactByName(artifactName) {
  const { webpackArtifact, serverlessArtifact } = getArtifactLocations.call(this, artifactName);

  // Make sure the destination dir exists
  this.serverless.utils.writeFileDir(serverlessArtifact);

  fs.copyFileSync(webpackArtifact, serverlessArtifact);
}

function setServiceArtifactPath(artifactPath) {
  _.set(this.serverless, 'service.package.artifact', artifactPath);
}

function isIndividualPackaging() {
  return _.get(this.serverless, 'service.package.individually');
}

function getArtifactName(entryFunction) {
  return `${entryFunction.funcName || this.serverless.service.getServiceObject().name}.zip`;
}

module.exports = {
  zip,
  async packageModules() {
    if (this.skipCompile) return;
    if (this.log) {
      this.log.verbose('[Webpack] Packaging modules');
      this.progress.get('webpack').notice('[Webpack] Packaging modules');
    }

    const { stats } = this.compileStats;
    const promises = stats.map(async (compileStats, index) => {
      const entryFunction = _.get(this.entryFunctions, index, {});
      const filename = getArtifactName.call(this, entryFunction);
      const modulePath = compileStats.outputPath;

      const startZip = _.now();
      const zipPath = await zip.call(this, modulePath, filename);
      if (this.log) {
        this.log.verbose(
          `Zip ${_.isEmpty(entryFunction) ? 'service' : 'function'}: ${modulePath} [${_.now() - startZip} ms]`
        );
      } else {
        this.options.verbose &&
          this.serverless.cli.log(
            `Zip ${_.isEmpty(entryFunction) ? 'service' : 'function'}: ${modulePath} [${_.now() - startZip} ms]`
          );
      }
      return zipPath;
    });
    const files = await Promise.all(promises);
    return files;
  },

  copyExistingArtifacts() {
    if (this.log) {
      this.log.verbose('[Webpack] Copying existing artifacts');
      this.progress.get('webpack').notice('[Webpack] Copying existing artifacts');
    } else {
      this.serverless.cli.log('Copying existing artifacts...');
    }
    // When invoked as a part of `deploy function`,
    // only function passed with `-f` flag should be processed.
    const functionNames = this.options.function ? [this.options.function] : getAllNodeFunctions.call(this);
    const serviceName = this.serverless.service.getServiceObject().name;
    const individualPackagingEnabled = isIndividualPackaging.call(this);
    const providerIsGoogle = isProviderGoogle(this.serverless);

    // Copy artifacts to package location
    if (individualPackagingEnabled) {
      _.forEach(functionNames, funcName => copyArtifactByName.call(this, funcName));
    } else {
      // Copy service packaged artifact
      copyArtifactByName.call(this, serviceName);
    }

    // Loop through every function and make sure that the correct artifact is assigned
    // (the one built by webpack)
    _.forEach(functionNames, funcName => {
      const func = this.serverless.service.getFunction(funcName);

      // When individual packaging is enabled, each functions gets it's own
      // artifact, otherwise every function gets set to the same artifact
      const archiveName = individualPackagingEnabled ? funcName : serviceName;

      const { serverlessArtifact } = getArtifactLocations.call(this, archiveName);
      setArtifactPath.call(this, funcName, func, serverlessArtifact);
    });

    // If we are deploying to 'google' we need to set an artifact for the whole service,
    // rather than for each function, so there is special case here
    if (!individualPackagingEnabled && providerIsGoogle) {
      const archiveName = serviceName;

      // This may look similar to the loop above, but note that this calls
      // setServiceArtifactPath rather than setArtifactPath
      const { serverlessArtifact } = getArtifactLocations.call(this, archiveName);
      setServiceArtifactPath.call(this, serverlessArtifact);
    }

    return BbPromise.resolve();
  }
};
