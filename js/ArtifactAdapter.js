const { AbstractArtifactAdapter } = require('@0xproject/sol-cov');
const globby = require('globby');
const path = require('path');
const fs = require('fs');

/**
 * note: This depends on @0xproject/sol-cov v2-prototype branch which hasn't been released yet.
 * in order to use the artifact adapter, you need to clone the @0xproject/0xmonorepo locally,
 * cd to `packages/sol-cov`, build the pkg, and link to your repo locally.
 *
 * ArtifactAdapter to be used with 0xproject/sol-cov package to provide code coverage
 * for your solidity contracts
 */
module.exports.default = class SolcpilerArtifactAdapter extends AbstractArtifactAdapter {
  /**
   * @param {string} artifactsPath Path to the directory containing the solcpiler artifacts
   * @param {string|array} excludes (optional) regEx or array of regExs to test the source
   *                                    against. If it matches, it will be excluded from the
   *                                    coverage report.
   *                                    Default: is to exclude any file in node_modules
   */
  constructor(artifactsPath, excludes = ['node_modules']) {
    super();
    this.artifactsPath = artifactsPath;
    this.excludes = excludes.map(r => (r instanceof RegExp ? r : new RegExp(r)));
    this.sources = {};
  }

  async collectContractsDataAsync() {
    const contracts = [];
    globby.sync(path.join(this.artifactsPath, '*.json')).forEach((file) => {
      const {
        compilerOutput,
        source: artifactSource,
        sources: artifactSources,
      } = require(require.resolve(file, { paths: [process.cwd()] }));

      if (this.excludes.some(p => p.test(artifactSource))) return;

      if (compilerOutput.abi && compilerOutput.evm.bytecode.object.length > 0) {
        const sourceCodes = [];
        const sources = [];

        Object.keys(artifactSources).forEach((sourceFile) => {
          const source = artifactSources[sourceFile];

          // check if we should exclude the file from coverage report
          if (this.excludes.some(p => p.test(source.file))) return;

          if (!this.sources[sourceFile]) {
            this.sources[sourceFile] = fs.readFileSync(source.file).toString();
          }

          sourceCodes[source.id] = this.sources[sourceFile];
          sources[source.id] = path.isAbsolute(sourceFile) || sourceFile.startsWith('.') ? sourceFile : source.file;
        });

        contracts.push({
          bytecode: compilerOutput.evm.bytecode.object,
          sourceMap: compilerOutput.evm.bytecode.sourceMap,
          runtimeBytecode: compilerOutput.evm.deployedBytecode.object,
          sourceMapRuntime: compilerOutput.evm.deployedBytecode.sourceMap,
          sourceCodes,
          sources,
        });
      }
    });

    return contracts;
  }
};
