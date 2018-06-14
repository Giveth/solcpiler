// TODO use @0xproject/sol-cov once they release v2-prototype branch
// const { AbstractArtifactAdapter } = require('@0xproject/sol-cov');
const { AbstractArtifactAdapter } = require('0xproject-sol-cov-fork');
const globby = require('globby');
const path = require('path');
const fs = require('fs');

/**
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
