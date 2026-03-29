require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const path = require('path');
const chatHandler = require('./api/chat');
const generateProposalHandler = require('./api/generate-proposal');

const app = express();
app.use(express.json());

// Serve static site files (my-site/)
app.use(express.static(__dirname));

// Serve ../assets/ so that HTML's "../assets/" paths resolve correctly
// Browser requests /assets/... when page is at root, so we map /assets → ../assets
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

// API routes — key never leaves the server
app.post('/api/chat', chatHandler);
app.post('/api/generate-proposal', generateProposalHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Enso site running at http://localhost:${PORT}`);
  console.log(`API key loaded: ${process.env.OPENROUTER_API_KEY ? 'YES' : 'NO — check .env'}`);
});
