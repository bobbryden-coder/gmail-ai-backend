const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken } = require('../middleware/auth');
const openaiService = require('../services/openai');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const prisma = new PrismaClient();

// Rate limiting
const aiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 requests per windowMs
  message: { error: 'Too many AI requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Usage checking middleware - handles trial, freemium (2/day), and paid users
const checkUsageLimit = async (req, res, next) => {
  try {
    const user = req.user;
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    // Get fresh user data
    const currentUser = await prisma.user.findUnique({
      where: { id: user.id }
    });

    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Determine user's plan type and limits
    const isTrialing = currentUser.subscriptionStatus === 'trialing' || currentUser.trialActive;
    const isActive = currentUser.subscriptionStatus === 'active';
    const isFreemium = currentUser.subscriptionStatus === 'freemium';
    const hasFullAccess = isTrialing || isActive || currentUser.isPremium;
    const isLimitedUser = !hasFullAccess; // Free/pending users share the 2/day limit

    console.log('📊 Usage check:', {
      userId: user.id,
      email: currentUser.email,
      subscriptionStatus: currentUser.subscriptionStatus,
      isTrialing,
      isActive,
      isFreemium,
      hasFullAccess
    });

    // FREE USERS (freemium/pending): Check 2 summaries per day limit using SummaryLog
    if (isLimitedUser) {
      const FREEMIUM_DAILY_LIMIT = 2;
      const dailyUsage = await getDailySummaryUsage(currentUser.id, FREEMIUM_DAILY_LIMIT);

      console.log(`📊 Free user ${currentUser.email}: ${dailyUsage.used}/${FREEMIUM_DAILY_LIMIT} summaries used today`);

      if (dailyUsage.used >= FREEMIUM_DAILY_LIMIT) {
        return res.status(429).json({
          error: 'Daily limit reached',
          message: 'Free users get 2 AI requests per day. Upgrade to Pro for unlimited access!',
          type: 'freemium_daily_limit',
          daily_limit_reached: true,
          summaries_used_today: dailyUsage.used,
          summaries_remaining: 0,
          daily_limit: FREEMIUM_DAILY_LIMIT,
          limit: FREEMIUM_DAILY_LIMIT,
          used: dailyUsage.used,
          remaining: 0,
          subscriptionStatus: 'freemium',
          upgradeUrl: process.env.UPGRADE_URL || 'https://gmail-ai-backend.vercel.app/pricing',
          benefits: [
            '✅ Unlimited AI summaries',
            '✅ Unlimited compose & reply',
            '✅ Unread email summary',
            '✅ Auto-labeling'
          ]
        });
      }

      // Store usage info in request for later
      req.freemiumUsage = {
        used: dailyUsage.used,
        limit: FREEMIUM_DAILY_LIMIT,
        remaining: FREEMIUM_DAILY_LIMIT - dailyUsage.used - 1 // -1 for this request
      };
    }

    // For trial/paid users: check the old daily/monthly limits (more generous)
    if (hasFullAccess) {
      const currentMonth = today.getMonth();
      const currentYear = today.getFullYear();

      // Check if we need to reset daily counter
      const lastUsageDate = currentUser.lastUsageDate;
      const isNewDay = !lastUsageDate || 
                       lastUsageDate.toDateString() !== today.toDateString();

      // Check if we need to reset monthly counter
      const lastResetDate = currentUser.lastResetDate;
      const isNewMonth = !lastResetDate || 
                         lastResetDate.getMonth() !== currentMonth ||
                         lastResetDate.getFullYear() !== currentYear;

      // Reset counters if needed
      if (isNewDay || isNewMonth) {
        const updateData = {};
        
        if (isNewDay) {
          updateData.dailyUsage = 0;
          updateData.lastUsageDate = today;
        }
        
        if (isNewMonth) {
          updateData.monthlyUsage = 0;
          updateData.lastResetDate = today;
        }
        
        await prisma.user.update({
          where: { id: user.id },
          data: updateData
        });
        
        currentUser.dailyUsage = updateData.dailyUsage !== undefined ? updateData.dailyUsage : currentUser.dailyUsage;
        currentUser.monthlyUsage = updateData.monthlyUsage !== undefined ? updateData.monthlyUsage : currentUser.monthlyUsage;
      }

      // Define limits for trial/paid users
      const LIMITS = {
        daily: 100,
        monthly: 3000
      };

      // Check daily limit
      if (currentUser.dailyUsage >= LIMITS.daily) {
        return res.status(429).json({
          error: 'Daily usage limit exceeded',
          type: 'daily_limit',
          used: currentUser.dailyUsage,
          limit: LIMITS.daily,
          subscriptionStatus: currentUser.subscriptionStatus
        });
      }

      // Check monthly limit
      if (currentUser.monthlyUsage >= LIMITS.monthly) {
        return res.status(429).json({
          error: 'Monthly usage limit exceeded',
          type: 'monthly_limit',
          used: currentUser.monthlyUsage,
          limit: LIMITS.monthly,
          subscriptionStatus: currentUser.subscriptionStatus
        });
      }
    }

    // Update req.user with current usage
    req.user = currentUser;
    
    next();

  } catch (error) {
    console.error('Error in checkUsageLimit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Helper function to log usage for freemium tracking
async function logSummaryUsage(userId, type = 'ai_request') {
  try {
    const record = await prisma.summaryLog.create({
      data: {
        userId: userId,
        type: type
      }
    });
    console.log('📊 SummaryLog created:', { id: record.id, userId, type });
    return record;
  } catch (error) {
    console.error('Error logging summary usage:', error);
    return null;
  }
}

// Helper to get today's usage count for limited users
async function getDailySummaryUsage(userId, limit = 2) {
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const used = await prisma.summaryLog.count({
    where: {
      userId,
      createdAt: { gte: todayStart }
    }
  });
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used)
  };
}


// Temporary backwards-compatible endpoint for old extension versions
// Returns helpful error message instead of 404, guides users to log in
// NOTE: This endpoint does NOT allow unauthenticated AI generation (security maintained)
router.post('/generate-test', async (req, res) => {
  // Check if user has auth token in headers
  const authHeader = req.headers.authorization;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    // If they have a token, tell them to use /generate endpoint
    res.status(400).json({
      error: 'This endpoint is deprecated. Please update your extension to the latest version.',
      requiresUpdate: true,
      message: 'Your extension is out of date. Please update from the Chrome Web Store to continue using AI features.'
    });
  } else {
    // No auth token - they need to log in
    res.status(401).json({
      error: 'Authentication required. Please log in to use AI features.',
      requiresAuth: true,
      message: 'Please log in through the extension popup to access AI features. If you continue to see this error, please update your extension.'
    });
  }
});

// Generate AI response
router.post('/generate', authenticateToken, aiRateLimit, checkUsageLimit, async (req, res) => {
  try {
    const { emailContent, style = 'brief', mode = 'response' } = req.body;

    // For compose mode, we need description instead of body
    if (mode === 'compose') {
      if (!emailContent || !emailContent.description) {
        return res.status(400).json({ error: 'Email description is required for compose mode' });
      }
      // Add a dummy body for compose mode to satisfy the AI service
      emailContent.body = emailContent.description;
    } else {
      if (!emailContent || !emailContent.body) {
        return res.status(400).json({ error: 'Email content is required' });
      }
    }

    // Generate AI response
    const result = await openaiService.generateEmailResponse(emailContent, style, mode);

    if (!result.success) {
      console.error('AI generation failed:', result.error);
      console.error('Full error details:', JSON.stringify(result, null, 2));
      return res.status(500).json({ 
        error: 'Failed to generate response',
        details: result.error || 'Unknown error',
        debug: process.env.NODE_ENV === 'development' ? result : undefined
      });
    }

    // Parse the AI response to extract the JSON
    let parsedResponse;
    try {
      console.log('Parsing AI response (authenticated):', result.response.substring(0, 200) + '...');
      
      // Remove the markdown code blocks if present
      let cleanResponse = result.response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      parsedResponse = JSON.parse(cleanResponse);
      console.log('✅ Successfully parsed AI response (authenticated)');
      
    } catch (parseError) {
      console.error('❌ Failed to parse AI response as JSON:', parseError.message);
      console.log('Raw response was:', result.response);
      
      // If parsing fails, return a simple response
      parsedResponse = {
        summary: "Email processed (parsing failed)",
        responses: [
          {
            label: "Generated Response",
            text: result.response
          }
        ],
        actions: ["Review response"]
      };
    }

    // Ensure responses is an array with proper structure
    if (!Array.isArray(parsedResponse.responses)) {
      parsedResponse.responses = [];
    }

    // Update user usage and get updated values
    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        dailyUsage: { increment: 1 },
        monthlyUsage: { increment: 1 }
      }
    });

    // Log usage for freemium tracking
    await logSummaryUsage(req.user.id, 'ai_generate');

    // Determine limits based on subscription status
    const isFreemium = req.user.subscriptionStatus === 'freemium';
    const hasFullAccess = req.user.subscriptionStatus === 'trialing' || 
                          req.user.subscriptionStatus === 'active' || 
                          req.user.trialActive ||
                          req.user.isPremium;

    // Log what we're sending back
    console.log('Sending authenticated response:', {
      summary: parsedResponse.summary,
      responsesCount: parsedResponse.responses.length,
      actionsCount: parsedResponse.actions?.length || 0,
      dailyUsage: updatedUser.dailyUsage,
      monthlyUsage: updatedUser.monthlyUsage,
      subscriptionStatus: req.user.subscriptionStatus
    });

    res.json({
      success: true,
      summary: parsedResponse.summary || 'Email analyzed',
      responses: parsedResponse.responses || [],
      actions: parsedResponse.actions || [],
      usage: {
        dailyUsed: updatedUser.dailyUsage,
        monthlyUsed: updatedUser.monthlyUsage,
        dailyLimit: hasFullAccess ? 100 : 2,
        monthlyLimit: hasFullAccess ? 3000 : 60,
        subscriptionStatus: req.user.subscriptionStatus,
        // For limited users, include remaining count
        ...(req.freemiumUsage ? {
          freemiumUsed: req.freemiumUsage.used + 1,
          freemiumLimit: req.freemiumUsage.limit,
          freemiumRemaining: Math.max(0, req.freemiumUsage.remaining)
        } : {})
      }
    });

  } catch (error) {
    console.error('AI generation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user usage stats
router.get('/usage', authenticateToken, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id }
  });

  res.json({
    dailyUsage: user.dailyUsage,
    monthlyUsage: user.monthlyUsage,
    dailyLimit: user.isPremium ? 100 : 10,
    isPremium: user.isPremium
  });
});

// Summarize email endpoint - now requires auth and has freemium limits
router.post('/summarize', authenticateToken, checkUsageLimit, async (req, res) => {
  try {
    const { email, options = {} } = req.body;

    if (!email || !email.body) {
      return res.status(400).json({ 
        error: 'Email content is required',
        received: { hasEmail: !!email, hasBody: !!email?.body }
      });
    }

    console.log('📧 Summarize request:', {
      subject: email.subject,
      sender: email.sender,
      bodyLength: email.body?.length || 0,
      userId: req.user.id,
      subscriptionStatus: req.user.subscriptionStatus
    });

    const hasFullAccess = req.user.subscriptionStatus === 'trialing' ||
      req.user.subscriptionStatus === 'active' ||
      req.user.trialActive ||
      req.user.isPremium;

    if (!hasFullAccess) {
      const dailyUsage = await getDailySummaryUsage(req.user.id, 2);
      if (dailyUsage.used >= 2) {
        return res.status(429).json({
          success: false,
          daily_limit_reached: true,
          summaries_used_today: dailyUsage.used,
          summaries_remaining: 0,
          daily_limit: 2,
          error: 'Daily limit reached. Upgrade to Pro for unlimited access.'
        });
      }
    }

    // Use the existing OpenAI service to generate summary
    const result = await openaiService.generateEmailResponse(
      {
        subject: email.subject || '',
        sender: email.sender || '',
        body: email.body || ''
      },
      options.style || 'brief',
      'response' // mode
    );

    if (!result.success) {
      console.error('Summarization failed:', result.error);
      return res.status(500).json({ 
        error: 'Failed to generate summary',
        details: result.error || 'Unknown error'
      });
    }

    // Log usage for freemium tracking
    await logSummaryUsage(req.user.id, 'email_summary');

    // Update user usage counters
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        dailyUsage: { increment: 1 },
        monthlyUsage: { increment: 1 }
      }
    });

    // Parse the AI response
    let parsedResponse;
    try {
      let cleanResponse = result.response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsedResponse = JSON.parse(cleanResponse);
    } catch (parseError) {
      console.error('Failed to parse summary response:', parseError);
      // Return a simple summary if parsing fails
      parsedResponse = {
        summary: result.response.substring(0, 200) + (result.response.length > 200 ? '...' : ''),
        responses: [],
        actions: []
      };
    }

    // Determine remaining usage for response (always include counts)
    const usageCounts = await getDailySummaryUsage(req.user.id, 2);
    console.log('✅ [SUMMARY] Response counts:', {
      used: usageCounts.used,
      remaining: usageCounts.remaining,
      daily_limit: usageCounts.limit
    });
    
    // Return summary in a clean format
    res.json({
      success: true,
      summary: parsedResponse.summary || 'No summary available',
      actions: parsedResponse.actions || [],
      keyPoints: parsedResponse.keyPoints || [],
      sentiment: parsedResponse.sentiment,
      urgency: parsedResponse.urgency,
      tokensUsed: result.tokensUsed,
      cost: result.cost,
      daily_limit: usageCounts.limit,
      summaries_used_today: usageCounts.used,
      summaries_remaining: usageCounts.remaining,
      // Include usage info for limited users
      ...(req.freemiumUsage ? {
        usage: {
          used: req.freemiumUsage.used + 1,
          limit: req.freemiumUsage.limit,
          remaining: Math.max(0, req.freemiumUsage.remaining),
          message: req.freemiumUsage.remaining > 0 
            ? `${req.freemiumUsage.remaining} summary left today`
            : 'Last free summary for today!'
        }
      } : {})
    });

  } catch (error) {
    console.error('Summarization error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// Generate context-aware reply options
router.post('/reply-options', authenticateToken, aiRateLimit, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.body) {
      return res.status(400).json({ error: 'Email content is required' });
    }

    console.log('📧 Reply options request:', {
      subject: email.subject,
      sender: email.sender,
      bodyLength: email.body?.length || 0
    });

    // Create a prompt to generate context-aware reply options
    const prompt = `Analyze this email and suggest 3 different response tones that would be appropriate.

Email Subject: ${email.subject || 'No subject'}
From: ${email.sender || 'Unknown'}
Body: ${email.body.substring(0, 1500)}

Respond with a JSON object containing an "options" array with exactly 3 options. Each option should have:
- "label": A short 2-4 word label (e.g., "Accept & Confirm", "Politely Decline", "Request More Info")
- "description": A brief 10-15 word description of what this response would convey
- "tone": A single word describing the tone (e.g., "positive", "negative", "neutral", "curious", "grateful", "apologetic")

The options should be contextually appropriate for the email content. For example:
- Meeting invite → Accept, Decline, Suggest Alternative Time
- Question → Answer Positively, Answer Negatively, Ask for Clarification
- Request → Agree to Help, Unable to Help, Need More Details
- Complaint → Apologize & Resolve, Explain Situation, Request Details

Return ONLY valid JSON, no markdown:
{"options": [{"label": "...", "description": "...", "tone": "..."}, ...]}`;

    const result = await openaiService.generateRaw(prompt);

    if (!result.success) {
      throw new Error(result.error || 'Failed to generate options');
    }

    // Parse the response
    let options;
    try {
      let cleanResponse = result.response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleanResponse);
      options = parsed.options;
    } catch (parseError) {
      console.error('Failed to parse reply options:', parseError);
      // Fallback options
      options = [
        { label: "Positive Response", description: "Agree, accept, or respond enthusiastically", tone: "positive" },
        { label: "Polite Decline", description: "Respectfully decline or say no", tone: "negative" },
        { label: "Need More Info", description: "Ask questions or request clarification", tone: "neutral" }
      ];
    }

    res.json({
      success: true,
      options: options
    });

  } catch (error) {
    console.error('Reply options error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Generate full reply with specified tone
router.post('/generate-reply', authenticateToken, aiRateLimit, checkUsageLimit, async (req, res) => {
  try {
    const { email, tone } = req.body;

    if (!email || !email.body) {
      return res.status(400).json({ error: 'Email content is required' });
    }

    if (!tone) {
      return res.status(400).json({ error: 'Response tone is required' });
    }

    console.log('📧 Generate reply request:', {
      subject: email.subject,
      sender: email.sender,
      tone: tone,
      bodyLength: email.body?.length || 0
    });

    // Create a prompt to generate a full reply with the selected tone
    const prompt = `Write a professional email reply with a "${tone}" tone.

Original Email:
Subject: ${email.subject || 'No subject'}
From: ${email.sender || 'Unknown'}
Body: ${email.body.substring(0, 2000)}

Instructions:
1. Write a complete, professional reply with a "${tone}" tone
2. Be concise but thorough (2-4 paragraphs)
3. Include appropriate greeting and sign-off
4. Match the formality level of the original email
5. Address the main points of the original email

Return ONLY the email body text (no JSON, no subject line, just the reply content):`;

    const result = await openaiService.generateRaw(prompt);

    if (!result.success) {
      throw new Error(result.error || 'Failed to generate reply');
    }

    // Update user usage
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        dailyUsage: { increment: 1 },
        monthlyUsage: { increment: 1 }
      }
    });

    // Log usage for freemium tracking
    await logSummaryUsage(req.user.id, 'reply_generate');

    res.json({
      success: true,
      replyBody: result.response.trim(),
      ...(req.freemiumUsage ? {
        daily_limit: req.freemiumUsage.limit,
        summaries_used_today: req.freemiumUsage.used + 1,
        summaries_remaining: Math.max(0, req.freemiumUsage.remaining)
      } : {})
    });

  } catch (error) {
    console.error('Generate reply error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Generate compose email options in different styles
router.post('/generate-compose', authenticateToken, aiRateLimit, checkUsageLimit, async (req, res) => {
  try {
    const { to, subject, description } = req.body;

    if (!to || !subject || !description) {
      return res.status(400).json({ error: 'To, subject, and description are required' });
    }

    console.log('📧 Generate compose request:', {
      to: to,
      subject: subject,
      descriptionLength: description?.length || 0
    });

    // Create a prompt to generate emails in different styles
    const prompt = `Write 3 complete email drafts in different styles based on this information:

To: ${to}
Subject: ${subject}
What to write about: ${description}

Generate complete, ready-to-send email bodies (no subject line, just the body text) in each style:
1. Professional - formal, business tone, polished language
2. Casual - friendly, conversational, relaxed
3. Creative - engaging, unique approach, memorable

Each email should be 3-5 sentences with appropriate greeting and sign-off.

Return ONLY valid JSON with no markdown:
{"professional": "email body here", "casual": "email body here", "creative": "email body here"}`;

    const result = await openaiService.generateRaw(prompt);

    if (!result.success) {
      throw new Error(result.error || 'Failed to generate emails');
    }

    // Parse the response
    let emails;
    try {
      let cleanResponse = result.response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      emails = JSON.parse(cleanResponse);
    } catch (parseError) {
      console.error('Failed to parse compose emails:', parseError);
      // Fallback emails
      emails = {
        professional: `Dear ${to.split('@')[0]},\n\nI hope this email finds you well. ${description}\n\nPlease let me know if you have any questions.\n\nBest regards`,
        casual: `Hey ${to.split('@')[0]}!\n\n${description}\n\nLet me know what you think!\n\nCheers`,
        creative: `Hi ${to.split('@')[0]}!\n\n${description}\n\nLooking forward to hearing from you!\n\nBest`
      };
    }

    const cleanEmailBody = (body) => {
      if (!body || typeof body !== 'string') {
        return body;
      }

      const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const paragraphs = normalized
        .split(/\n{2,}/)
        .map((paragraph) => paragraph
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .join(' ')
        )
        .filter((paragraph) => paragraph.length > 0);

      return paragraphs.join('\n\n');
    };

    console.log('📧 [COMPOSE] RAW AI RESPONSE:', {
      professional: emails?.professional,
      casual: emails?.casual,
      creative: emails?.creative
    });

    emails = {
      professional: cleanEmailBody(emails?.professional),
      casual: cleanEmailBody(emails?.casual),
      creative: cleanEmailBody(emails?.creative)
    };

    console.log('📧 [COMPOSE] CLEANED RESPONSE:', {
      professional: emails?.professional,
      casual: emails?.casual,
      creative: emails?.creative
    });

    console.log('📧 [COMPOSE] Cleaned text (no embedded newlines) for response');

    // Post-generation quality gate: check each tone variant
    const toneKeys = ['professional', 'casual', 'creative'];
    let anyFailed = false;
    for (const key of toneKeys) {
      if (!emails[key]) continue;
      const check = openaiService.checkDraftQuality(emails[key]);
      if (!check.pass) {
        console.warn(`[QualityGate] compose/${key} failed: [${check.check}] ${check.reason}`);
        anyFailed = true;
      }
    }

    // If any tone failed quality, retry the whole generation once
    if (anyFailed) {
      console.log('[QualityGate] Retrying compose generation...');
      const retryResult = await openaiService.generateRaw(prompt);
      if (retryResult.success) {
        try {
          let retryClean = retryResult.response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          const retryEmails = JSON.parse(retryClean);
          for (const key of toneKeys) {
            if (retryEmails[key]) {
              const cleaned = cleanEmailBody(retryEmails[key]);
              const retryCheck = openaiService.checkDraftQuality(cleaned);
              if (retryCheck.pass) {
                emails[key] = cleaned;
              } else {
                console.warn(`[QualityGate] Retry compose/${key} still failed: [${retryCheck.check}] ${retryCheck.reason}`);
                // Fallback for this tone
                const name = to.split('@')[0] || 'there';
                emails[key] = `Hi ${name},\n\nI wanted to reach out regarding the role described above. Would you be open to a brief conversation this week?\n\nBest regards`;
                console.warn(`[QualityGate] Using fallback for compose/${key}`);
              }
            }
          }
        } catch (retryParseErr) {
          console.error('[QualityGate] Retry parse failed:', retryParseErr.message);
        }
      }
    }

    // Update user usage
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        dailyUsage: { increment: 1 },
        monthlyUsage: { increment: 1 }
      }
    });

    // Log usage for freemium tracking
    await logSummaryUsage(req.user.id, 'compose_generate');

    res.json({
      success: true,
      emails: emails,
      ...(req.freemiumUsage ? {
        daily_limit: req.freemiumUsage.limit,
        summaries_used_today: req.freemiumUsage.used + 1,
        summaries_remaining: Math.max(0, req.freemiumUsage.remaining)
      } : {})
    });

  } catch (error) {
    console.error('Generate compose error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Analyze email category for tagging
router.post('/analyze-category', authenticateToken, aiRateLimit, async (req, res) => {
  try {
    const { subject, body, sender } = req.body;

    if (!body && !subject) {
      return res.status(400).json({ error: 'Email content is required' });
    }

    console.log('📧 Analyze category request:', {
      subject: subject?.substring(0, 50),
      sender: sender,
      bodyLength: body?.length || 0
    });

    const prompt = `Categorize this email into exactly ONE category.

From: ${sender || 'Unknown'}
Subject: ${subject || 'No subject'}
Body: ${(body || '').substring(0, 800)}

Categories (choose ONE):
- Marketing (newsletters, promotions, ads, product announcements)
- Invoice (receipts, bills, payment confirmations, statements)
- Support (help requests, customer service, tickets)
- Work (business emails, meetings, projects, colleagues)
- Social (social media notifications, friend requests, likes)
- News (articles, digests, news alerts, updates)
- Urgent (time-sensitive, deadlines, important actions needed)
- Docs (guides, documentation, terms, policies)
- Personal (friends, family, personal matters)
- Shipping (order tracking, delivery updates, shipping confirmations)

Return ONLY valid JSON with no markdown:
{"category": "Marketing", "confidence": 0.95, "reasoning": "Brief explanation"}`;

    const result = await openaiService.generateRaw(prompt);

    if (!result.success) {
      throw new Error(result.error || 'Failed to analyze category');
    }

    let analysis;
    try {
      let cleanResponse = result.response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysis = JSON.parse(cleanResponse);
    } catch (parseError) {
      console.error('Failed to parse category analysis:', parseError);
      // Default fallback
      analysis = {
        category: 'Work',
        confidence: 0.5,
        reasoning: 'Could not determine category'
      };
    }

    res.json({
      success: true,
      category: analysis.category,
      confidence: analysis.confidence,
      reasoning: analysis.reasoning
    });

  } catch (error) {
    console.error('Analyze category error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Batch classify multiple emails at once (Premium feature)
router.post('/batch-classify', authenticateToken, async (req, res) => {
  try {
    const { emails } = req.body;

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'emails array is required' });
    }

    // Limit batch size to prevent abuse
    const maxBatchSize = 50;
    const emailsToProcess = emails.slice(0, maxBatchSize);

    console.log(`📧 Batch classify request: ${emailsToProcess.length} emails`);

    const results = [];

    // Process emails in parallel batches of 5 for speed
    const batchSize = 5;
    for (let i = 0; i < emailsToProcess.length; i += batchSize) {
      const batch = emailsToProcess.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (email) => {
        try {
          const prompt = `Quickly categorize this email into ONE category.

From: ${email.sender || email.from || 'Unknown'}
Subject: ${email.subject || 'No subject'}
Body: ${(email.body || '').substring(0, 300)}

Categories: Marketing, Invoice, Support, Work, Social, News, Urgent, Docs, Personal, Shipping

Return ONLY JSON: {"category": "Marketing", "confidence": 0.9}`;

          const result = await openaiService.generateRaw(prompt);

          if (!result.success) {
            return {
              messageId: email.messageId,
              category: 'Work',
              confidence: 0.5,
              error: 'Classification failed'
            };
          }

          let classification;
          try {
            let cleanResponse = result.response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            classification = JSON.parse(cleanResponse);
          } catch (parseError) {
            classification = { category: 'Work', confidence: 0.5 };
          }

          return {
            messageId: email.messageId,
            category: classification.category,
            confidence: classification.confidence
          };
        } catch (error) {
          console.error(`Error classifying email ${email.messageId}:`, error.message);
          return {
            messageId: email.messageId,
            category: 'Work',
            confidence: 0.5,
            error: error.message
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      console.log(`📧 Batch ${Math.floor(i / batchSize) + 1} complete: ${batchResults.length} classified`);
    }

    console.log(`✅ Batch classification complete: ${results.length} emails`);

    res.json({
      success: true,
      results: results,
      processed: results.length,
      total: emails.length
    });

  } catch (error) {
    console.error('Batch classify error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Batch summarize multiple emails (for Unread Summary feature)
router.post('/summarize-batch', authenticateToken, async (req, res) => {
  try {
    const { emails } = req.body;

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'emails array is required' });
    }

    // Limit batch size
    const maxBatchSize = 50;
    const emailsToProcess = emails.slice(0, maxBatchSize);

    console.log(`📧 Batch summarize request: ${emailsToProcess.length} emails`);

    const summaries = [];

    // Process emails in parallel batches of 5 for speed
    const batchSize = 5;
    for (let i = 0; i < emailsToProcess.length; i += batchSize) {
      const batch = emailsToProcess.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (email, index) => {
        try {
          const prompt = `Summarize this email in 1-2 concise sentences. Focus on the key point or action needed.

From: ${email.from || email.sender || 'Unknown'}
Subject: ${email.subject || 'No subject'}
Body: ${(email.body || '').substring(0, 500)}

Return ONLY the summary, nothing else.`;

          const result = await openaiService.generateRaw(prompt);

          if (!result.success) {
            return {
              messageId: email.messageId,
              from: email.from || email.sender,
              subject: email.subject,
              summary: 'Could not summarize this email.',
              error: true
            };
          }

          return {
            messageId: email.messageId,
            from: email.from || email.sender,
            subject: email.subject,
            summary: result.response.trim(),
            category: email.category || null
          };
        } catch (error) {
          console.error(`Error summarizing email ${email.messageId}:`, error.message);
          return {
            messageId: email.messageId,
            from: email.from || email.sender,
            subject: email.subject,
            summary: 'Error summarizing this email.',
            error: true
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      summaries.push(...batchResults);

      console.log(`📧 Batch ${Math.floor(i / batchSize) + 1} complete: ${batchResults.length} summarized`);
    }

    console.log(`✅ Batch summarization complete: ${summaries.length} emails`);

    res.json({
      success: true,
      summaries: summaries,
      processed: summaries.length,
      total: emails.length
    });

  } catch (error) {
    console.error('Batch summarize error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Debug endpoint removed for production
// If needed for debugging, uncomment and use temporarily

module.exports = router;
