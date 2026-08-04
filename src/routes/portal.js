const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken } = require('../middleware/auth');
const openaiService = require('../services/openai');

const router = express.Router();
const prisma = new PrismaClient();

// ---- Validation helpers ----

const VALID_JOB_STATUSES = ['open', 'filled', 'closed'];
const VALID_CANDIDATE_STATUSES = ['contacted', 'replied', 'booked', 'rejected', 'no_response'];
const VALID_CHANNELS = ['linkedin_note', 'dm', 'inmail', 'email'];
const VALID_DIRECTIONS = ['sent', 'received'];

function validateEnum(value, allowed, fieldName) {
  if (value && !allowed.includes(value)) {
    return `Invalid ${fieldName}: "${value}". Must be one of: ${allowed.join(', ')}`;
  }
  return null;
}

// ---- Ownership helpers ----

async function getJobPostingOwned(id, userId) {
  const posting = await prisma.jobPosting.findUnique({ where: { id } });
  if (!posting || posting.userId !== userId) return null;
  return posting;
}

async function getCandidateOwned(id, userId) {
  const candidate = await prisma.candidate.findUnique({
    where: { id },
    include: { jobPosting: true }
  });
  if (!candidate || candidate.userId !== userId) return null;
  return candidate;
}

// ============================================================
// JOB POSTINGS CRUD
// ============================================================

// List job postings for the authenticated user
router.get('/job-postings', authenticateToken, async (req, res) => {
  try {
    const postings = await prisma.jobPosting.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { candidates: true } } }
    });
    res.json({ success: true, postings });
  } catch (error) {
    console.error('List job postings error:', error);
    res.status(500).json({ error: 'Failed to list job postings' });
  }
});

// Create job posting
router.post('/job-postings', authenticateToken, async (req, res) => {
  try {
    const { title, company, description } = req.body;
    if (!title || !company || !description) {
      return res.status(400).json({ error: 'title, company, and description are required' });
    }
    const posting = await prisma.jobPosting.create({
      data: { userId: req.user.id, title, company, description }
    });
    res.status(201).json({ success: true, posting });
  } catch (error) {
    console.error('Create job posting error:', error);
    res.status(500).json({ error: 'Failed to create job posting' });
  }
});

// Get single job posting
router.get('/job-postings/:id', authenticateToken, async (req, res) => {
  try {
    const posting = await getJobPostingOwned(req.params.id, req.user.id);
    if (!posting) return res.status(404).json({ error: 'Job posting not found' });
    res.json({ success: true, posting });
  } catch (error) {
    console.error('Get job posting error:', error);
    res.status(500).json({ error: 'Failed to get job posting' });
  }
});

// Update job posting
router.put('/job-postings/:id', authenticateToken, async (req, res) => {
  try {
    const posting = await getJobPostingOwned(req.params.id, req.user.id);
    if (!posting) return res.status(404).json({ error: 'Job posting not found' });

    const { title, company, description, status } = req.body;
    const err = validateEnum(status, VALID_JOB_STATUSES, 'status');
    if (err) return res.status(400).json({ error: err });

    const data = {};
    if (title !== undefined) data.title = title;
    if (company !== undefined) data.company = company;
    if (description !== undefined) data.description = description;
    if (status !== undefined) data.status = status;

    const updated = await prisma.jobPosting.update({ where: { id: posting.id }, data });
    res.json({ success: true, posting: updated });
  } catch (error) {
    console.error('Update job posting error:', error);
    res.status(500).json({ error: 'Failed to update job posting' });
  }
});

// Delete job posting
router.delete('/job-postings/:id', authenticateToken, async (req, res) => {
  try {
    const posting = await getJobPostingOwned(req.params.id, req.user.id);
    if (!posting) return res.status(404).json({ error: 'Job posting not found' });

    await prisma.jobPosting.delete({ where: { id: posting.id } });
    res.json({ success: true, message: 'Job posting deleted' });
  } catch (error) {
    console.error('Delete job posting error:', error);
    res.status(500).json({ error: 'Failed to delete job posting' });
  }
});

// ============================================================
// CANDIDATES CRUD (scoped under a job posting)
// ============================================================

// List candidates for a posting
router.get('/job-postings/:id/candidates', authenticateToken, async (req, res) => {
  try {
    const posting = await getJobPostingOwned(req.params.id, req.user.id);
    if (!posting) return res.status(404).json({ error: 'Job posting not found' });

    const candidates = await prisma.candidate.findMany({
      where: { jobPostingId: posting.id, userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        outreachLogs: {
          where: { direction: 'received' },
          select: { id: true },
          take: 1
        }
      }
    });

    const result = candidates.map(c => ({
      id: c.id,
      name: c.name,
      linkedinUrl: c.linkedinUrl,
      headline: c.headline,
      status: c.status,
      lastContactedAt: c.lastContactedAt,
      hasReplied: c.outreachLogs.length > 0,
      createdAt: c.createdAt
    }));

    res.json({ success: true, candidates: result });
  } catch (error) {
    console.error('List candidates error:', error);
    res.status(500).json({ error: 'Failed to list candidates' });
  }
});

// Create candidate under a posting
router.post('/job-postings/:id/candidates', authenticateToken, async (req, res) => {
  try {
    const posting = await getJobPostingOwned(req.params.id, req.user.id);
    if (!posting) return res.status(404).json({ error: 'Job posting not found' });

    const { name, linkedinUrl, headline, summary, status } = req.body;
    if (!name || !linkedinUrl) {
      return res.status(400).json({ error: 'name and linkedinUrl are required' });
    }
    const err = validateEnum(status, VALID_CANDIDATE_STATUSES, 'status');
    if (err) return res.status(400).json({ error: err });

    const candidate = await prisma.candidate.create({
      data: {
        jobPostingId: posting.id,
        userId: req.user.id,
        name,
        linkedinUrl,
        headline: headline || null,
        summary: summary || null,
        status: status || 'contacted'
      }
    });
    res.status(201).json({ success: true, candidate });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Candidate already exists for this posting and LinkedIn URL' });
    }
    console.error('Create candidate error:', error);
    res.status(500).json({ error: 'Failed to create candidate' });
  }
});

// Get single candidate (full detail with notes + outreach timeline)
router.get('/job-postings/:postingId/candidates/:candidateId', authenticateToken, async (req, res) => {
  try {
    const candidate = await getCandidateOwned(req.params.candidateId, req.user.id);
    if (!candidate || candidate.jobPostingId !== req.params.postingId) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    const full = await prisma.candidate.findUnique({
      where: { id: candidate.id },
      include: {
        notes: { orderBy: { createdAt: 'desc' } },
        outreachLogs: { orderBy: { createdAt: 'asc' } },
        jobPosting: { select: { title: true, company: true } }
      }
    });

    res.json({ success: true, candidate: full });
  } catch (error) {
    console.error('Get candidate error:', error);
    res.status(500).json({ error: 'Failed to get candidate' });
  }
});

// Update candidate
router.put('/job-postings/:postingId/candidates/:candidateId', authenticateToken, async (req, res) => {
  try {
    const candidate = await getCandidateOwned(req.params.candidateId, req.user.id);
    if (!candidate || candidate.jobPostingId !== req.params.postingId) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    const { name, headline, summary, status } = req.body;
    const err = validateEnum(status, VALID_CANDIDATE_STATUSES, 'status');
    if (err) return res.status(400).json({ error: err });

    const data = {};
    if (name !== undefined) data.name = name;
    if (headline !== undefined) data.headline = headline;
    if (summary !== undefined) data.summary = summary;
    if (status !== undefined) data.status = status;

    const updated = await prisma.candidate.update({ where: { id: candidate.id }, data });
    res.json({ success: true, candidate: updated });
  } catch (error) {
    console.error('Update candidate error:', error);
    res.status(500).json({ error: 'Failed to update candidate' });
  }
});

// Delete candidate
router.delete('/job-postings/:postingId/candidates/:candidateId', authenticateToken, async (req, res) => {
  try {
    const candidate = await getCandidateOwned(req.params.candidateId, req.user.id);
    if (!candidate || candidate.jobPostingId !== req.params.postingId) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    await prisma.candidate.delete({ where: { id: candidate.id } });
    res.json({ success: true, message: 'Candidate deleted' });
  } catch (error) {
    console.error('Delete candidate error:', error);
    res.status(500).json({ error: 'Failed to delete candidate' });
  }
});

// ============================================================
// NOTES & OUTREACH
// ============================================================

// Add note to candidate
router.post('/candidates/:id/notes', authenticateToken, async (req, res) => {
  try {
    const candidate = await getCandidateOwned(req.params.id, req.user.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    const { noteText } = req.body;
    if (!noteText) return res.status(400).json({ error: 'noteText is required' });

    const note = await prisma.caseNote.create({
      data: { candidateId: candidate.id, noteText }
    });
    res.status(201).json({ success: true, note });
  } catch (error) {
    console.error('Add note error:', error);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// Log outreach entry
router.post('/candidates/:id/outreach', authenticateToken, async (req, res) => {
  try {
    const candidate = await getCandidateOwned(req.params.id, req.user.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    const { channel, messageText, direction } = req.body;
    if (!channel || !messageText || !direction) {
      return res.status(400).json({ error: 'channel, messageText, and direction are required' });
    }

    let err = validateEnum(channel, VALID_CHANNELS, 'channel');
    if (err) return res.status(400).json({ error: err });
    err = validateEnum(direction, VALID_DIRECTIONS, 'direction');
    if (err) return res.status(400).json({ error: err });

    const log = await prisma.outreachLog.create({
      data: { candidateId: candidate.id, channel, messageText, direction }
    });

    // Update lastContactedAt if this is a sent message
    if (direction === 'sent') {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { lastContactedAt: new Date() }
      });
    }

    // Update candidate status to "replied" if receiving a message
    if (direction === 'received' && candidate.status === 'contacted') {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { status: 'replied' }
      });
    }

    res.status(201).json({ success: true, log });
  } catch (error) {
    console.error('Log outreach error:', error);
    res.status(500).json({ error: 'Failed to log outreach' });
  }
});

// ============================================================
// GENERATE FOLLOW-UP
// ============================================================

router.post('/candidates/:id/generate-followup', authenticateToken, async (req, res) => {
  try {
    const candidate = await getCandidateOwned(req.params.id, req.user.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    // Get the job posting
    const jobPosting = await prisma.jobPosting.findUnique({
      where: { id: candidate.jobPostingId }
    });

    // Get the most recent received message
    const lastReceived = await prisma.outreachLog.findFirst({
      where: { candidateId: candidate.id, direction: 'received' },
      orderBy: { createdAt: 'desc' }
    });

    // Get the most recent sent message for context
    const lastSent = await prisma.outreachLog.findFirst({
      where: { candidateId: candidate.id, direction: 'sent' },
      orderBy: { createdAt: 'desc' }
    });

    const prompt = buildFollowUpPrompt({
      candidateName: candidate.name,
      candidateSummary: candidate.summary,
      candidateHeadline: candidate.headline,
      jobTitle: jobPosting ? jobPosting.title : '',
      jobCompany: jobPosting ? jobPosting.company : '',
      jobDescription: jobPosting ? jobPosting.description : '',
      lastSentMessage: lastSent ? lastSent.messageText : '',
      lastReceivedMessage: lastReceived ? lastReceived.messageText : '',
      channel: lastReceived ? lastReceived.channel : (lastSent ? lastSent.channel : 'email')
    });

    const result = await openaiService.generateRaw(prompt);
    if (!result.success) {
      return res.status(500).json({ error: 'Failed to generate follow-up: ' + result.error });
    }

    res.json({ success: true, followUp: result.response.trim() });
  } catch (error) {
    console.error('Generate follow-up error:', error);
    res.status(500).json({ error: 'Failed to generate follow-up' });
  }
});

function buildFollowUpPrompt(opts) {
  let prompt =
    'Write a follow-up message to a candidate who replied to a recruiter outreach.\n\n' +
    'RULES:\n' +
    '- Directly address what the candidate said in their reply. If they asked questions, answer them. If they expressed interest, propose a next step.\n' +
    '- Use ONLY facts provided below. Do NOT invent, assume, or infer anything about the candidate or the role that is not explicitly stated.\n' +
    '- BANNED phrases (never use): "extensive experience," "compelling candidate," "exciting opportunity," "impressive background," "strong candidate," "invaluable," "would be an asset," "I was impressed by," "passionate about," "thrilled"\n' +
    '- Be concrete, direct, and short (3-5 sentences max). No flattery. No filler.\n' +
    '- Do not use em dashes. Do not use emojis.\n' +
    '- Write like a real person continuing a conversation, not a template.\n\n';

  prompt += '--- ROLE ---\n';
  if (opts.jobTitle) prompt += 'Title: ' + opts.jobTitle + '\n';
  if (opts.jobCompany) prompt += 'Company: ' + opts.jobCompany + '\n';
  if (opts.jobDescription) prompt += 'Description: ' + opts.jobDescription.substring(0, 500) + '\n';
  prompt += '\n';

  prompt += '--- CANDIDATE ---\n';
  prompt += 'Name: ' + opts.candidateName + '\n';
  if (opts.candidateHeadline) prompt += 'Headline: ' + opts.candidateHeadline + '\n';
  if (opts.candidateSummary) prompt += 'Summary: ' + opts.candidateSummary + '\n';
  prompt += '\n';

  if (opts.lastSentMessage) {
    prompt += '--- YOUR PREVIOUS MESSAGE (what you sent) ---\n';
    prompt += opts.lastSentMessage + '\n\n';
  }

  if (opts.lastReceivedMessage) {
    prompt += '--- CANDIDATE\'S REPLY (what they said) ---\n';
    prompt += opts.lastReceivedMessage + '\n\n';
  }

  prompt += 'Write ONLY the follow-up message text. No subject line. No quotation marks.\n';
  if (opts.channel === 'linkedin_note' || opts.channel === 'dm') {
    prompt += 'Keep it under 300 characters (this is a LinkedIn message).';
  }

  return prompt;
}

// ============================================================
// EXTENSION INTAKE
// ============================================================

router.post('/intake/generation', authenticateToken, async (req, res) => {
  try {
    const { jobPostingId, candidate: candidateData, messageText, channel } = req.body;

    if (!candidateData || !candidateData.name || !candidateData.linkedinUrl) {
      return res.status(400).json({ error: 'candidate.name and candidate.linkedinUrl are required' });
    }
    if (!messageText) {
      return res.status(400).json({ error: 'messageText is required' });
    }

    const ch = channel || 'email';
    const err = validateEnum(ch, VALID_CHANNELS, 'channel');
    if (err) return res.status(400).json({ error: err });

    // Verify job posting ownership if provided
    let postingId = jobPostingId;
    if (postingId) {
      const posting = await getJobPostingOwned(postingId, req.user.id);
      if (!posting) return res.status(404).json({ error: 'Job posting not found' });
    } else {
      // If no posting provided, use or create a default "Unassigned" posting
      let defaultPosting = await prisma.jobPosting.findFirst({
        where: { userId: req.user.id, title: 'Unassigned', status: 'open' }
      });
      if (!defaultPosting) {
        defaultPosting = await prisma.jobPosting.create({
          data: {
            userId: req.user.id,
            title: 'Unassigned',
            company: '',
            description: 'Candidates added from the extension without a specific job posting.'
          }
        });
      }
      postingId = defaultPosting.id;
    }

    // Create or find the candidate (upsert by unique constraint)
    let candidate;
    const existing = await prisma.candidate.findUnique({
      where: {
        userId_jobPostingId_linkedinUrl: {
          userId: req.user.id,
          jobPostingId: postingId,
          linkedinUrl: candidateData.linkedinUrl
        }
      }
    });

    let isNew = false;
    if (existing) {
      candidate = existing;
      // Update lastContactedAt on repeat contact
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { lastContactedAt: new Date() }
      });
    } else {
      isNew = true;
      candidate = await prisma.candidate.create({
        data: {
          jobPostingId: postingId,
          userId: req.user.id,
          name: candidateData.name,
          linkedinUrl: candidateData.linkedinUrl,
          headline: candidateData.headline || null,
          status: 'contacted',
          lastContactedAt: new Date()
        }
      });
    }

    // Only log outreach if messageText differs from most recent sent entry (avoid duplicates)
    const lastSent = await prisma.outreachLog.findFirst({
      where: { candidateId: candidate.id, direction: 'sent' },
      orderBy: { createdAt: 'desc' }
    });

    let log = null;
    if (!lastSent || lastSent.messageText !== messageText) {
      log = await prisma.outreachLog.create({
        data: {
          candidateId: candidate.id,
          channel: ch,
          messageText: messageText,
          direction: 'sent'
        }
      });
    }

    // Async: generate candidate summary from profile data if provided and no summary exists
    if (candidateData.profileData && !candidate.summary) {
      generateCandidateSummary(candidate.id, candidateData.name, candidateData.profileData);
    }

    res.status(isNew ? 201 : 200).json({
      success: true,
      candidateId: candidate.id,
      outreachLogId: log ? log.id : null,
      isNew: isNew,
      duplicateMessage: !log
    });
  } catch (error) {
    console.error('Intake generation error:', error);
    res.status(500).json({ error: 'Failed to process intake' });
  }
});

// Fire-and-forget summary generation
async function generateCandidateSummary(candidateId, name, profileData) {
  try {
    const prompt =
      'Write a 2-3 sentence factual summary of this person based ONLY on the profile data below. ' +
      'Do NOT invent, assume, or infer anything not explicitly stated. ' +
      'Do NOT use flattery ("extensive experience", "impressive", "passionate"). ' +
      'Just state what they do, where they work, and any notable specifics from the data.\n\n' +
      '--- PROFILE DATA ---\n' +
      'Name: ' + name + '\n' +
      (typeof profileData === 'string' ? profileData : JSON.stringify(profileData)) + '\n\n' +
      'Write ONLY the summary, nothing else.';

    const result = await openaiService.generateRaw(prompt);
    if (result.success) {
      await prisma.candidate.update({
        where: { id: candidateId },
        data: { summary: result.response.trim() }
      });
      console.log('Generated summary for candidate:', candidateId);
    }
  } catch (error) {
    console.error('Failed to generate candidate summary:', error.message);
  }
}

module.exports = router;
