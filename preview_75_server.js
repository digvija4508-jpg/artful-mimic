const express = require('express');
const path = require('path');
const app = express();
const port = 3005;

// Serve static files from public (for style.css, logo.png, etc)
app.use(express.static('public'));

// Serve those specifically from the backup folder
app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'backups', 'restore_point_7_5', 'room.html'));
});

// Since the backup file expects /room.html to be served directly sometimes
app.get('/room.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'backups', 'restore_point_7_5', 'room.html'));
});

app.listen(port, () => {
  console.log(`🚀 Restore Point 7.5 preview running at http://localhost:${port}/room/PREVIEW`);
});
