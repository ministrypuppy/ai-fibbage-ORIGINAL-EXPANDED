// server.js (REPLACES your entire server.js file to restore the original setup)
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});