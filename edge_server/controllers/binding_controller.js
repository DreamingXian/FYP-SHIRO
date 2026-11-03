// =============================================================================
// Patient-Tag Binding Controller (Ready for Phase 4)
// =============================================================================
async function listBindings(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, message: 'Active bindings endpoint ready.' }));
}

module.exports = {
  listBindings
};

