const express = require('express');
const OpenAI = require('openai');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.post('/score', authenticateToken, async (req, res) => {
  try {
    const { criteria, candidates } = req.body;

    if (!criteria || typeof criteria !== 'string') {
      return res.status(400).json({ error: 'criteria string is required' });
    }
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return res.status(400).json({ error: 'candidates array is required' });
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
    }

    const openai = new OpenAI({ apiKey });

    const numberedList = candidates
      .map((c, i) => `${i + 1}. ${c.name} | ${c.headline || 'No headline'} | ${c.location || 'No location'}`)
      .join('\n');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      max_tokens: 1024,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: 'You are a recruiting assistant scoring candidates against a hiring criteria. Return ONLY valid JSON with a "scores" key containing an array of objects: { name, score, reason }. Score 1-10 where 10 is a perfect match. Be honest — most candidates won\'t be a 10.'
        },
        {
          role: 'user',
          content: `Criteria: ${criteria}\n\nCandidates:\n${numberedList}\n\nReturn JSON array.`
        }
      ]
    });

    const rawText = response.choices[0].message.content;
    let scores;
    try {
      const parsed = JSON.parse(rawText);
      scores = parsed.scores || parsed;
    } catch (parseErr) {
      console.error('Failed to parse scoring response:', parseErr.message);
      console.error('Raw response:', rawText);
      return res.status(500).json({ error: 'Failed to parse AI scoring response' });
    }

    // Merge scores back into candidates by matching name
    const scoreMap = {};
    scores.forEach(function (s) { scoreMap[s.name] = s; });

    const merged = candidates.map(function (c) {
      const s = scoreMap[c.name];
      return {
        name: c.name,
        headline: c.headline || '',
        location: c.location || '',
        profileUrl: c.profileUrl || '',
        score: s ? s.score : 0,
        reason: s ? s.reason : 'No score returned'
      };
    });

    res.json({ success: true, candidates: merged });

  } catch (error) {
    console.error('Recruiter score error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

module.exports = router;
