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
  constructor(artifactsPath) {
    super();
    this.artifactsPath = artifactsPath;
    this.sources = {};
  }

  async collectContractsDataAsync() {
    const contracts = [];
    globby.sync(path.join(this.artifactsPath, '*.json')).forEach((file) => {
      const { contractName, compilerOutput, sources: artifactSources } = require(require.resolve(
        file,
        { paths: [process.cwd()] },
      ));

      if (compilerOutput.abi && compilerOutput.evm.bytecode.object.length > 0) {
        const sourceCodes = [];
        const sources = [];

        Object.keys(artifactSources).forEach((sourceFile) => {
          const source = artifactSources[sourceFile];

          // we don't want to collect deps in code coverage report
          if (source.file.includes('node_modules')) return;

          if (!this.sources[sourceFile]) {
            this.sources[sourceFile] = fs.readFileSync(source.file).toString();
          }

          sourceCodes[source.id] = this.sources[sourceFile];
          sources[source.id] = sourceFile;
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
