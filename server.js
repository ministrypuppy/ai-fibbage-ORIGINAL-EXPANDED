const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.use(express.json());

// Load questions.json into memory
const questionsPath = path.join(__dirname, 'questions.json');
let questions = [];

try {
    const data = fs.readFileSync(questionsPath, 'utf8');
    questions = JSON.parse(data);
} catch (err) {
    console.error('Error reading questions.json:', err);
}

// Endpoint to pull a random question
app.get('/api/get-question', (req, res) => {
    if (questions.length === 0) {
        return res.status(500).json({ error: 'No questions available' });
    }
    const randomIndex = Math.floor(Math.random() * questions.length);
    res.json(questions[randomIndex]);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});