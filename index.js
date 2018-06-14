const api = require('./js/api.js');
const SolcpilerArtifactAdapter = require('./js/ArtifactAdapter').default;

module.exports = Object.assign({}, api, { SolcpilerArtifactAdapter });
