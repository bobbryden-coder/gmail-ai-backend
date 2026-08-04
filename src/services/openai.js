const OpenAI = require('openai');

// Initialize OpenAI client - will be recreated with fresh key on each request
function getOpenAIClient() {
  // Get raw key from environment
  const rawKey = process.env.OPENAI_API_KEY;
  const apiKey = rawKey?.trim();
  
  console.log('🔍 Raw environment check:', {
    hasRawKey: !!rawKey,
    rawKeyLength: rawKey?.length || 0,
    hasTrimmedKey: !!apiKey,
    trimmedKeyLength: apiKey?.length || 0,
    rawKeyType: typeof rawKey,
    allEnvKeys: Object.keys(process.env).filter(k => k.includes('OPENAI')).join(', ')
  });
  
  if (!apiKey) {
    console.error('⚠️ OPENAI_API_KEY is not set in environment variables!');
    throw new Error('OPENAI_API_KEY is required but not set');
  }

  // Log key status (without exposing the full key) - CRITICAL DEBUG INFO
  const keyInfo = {
    hasKey: !!apiKey,
    keyLength: apiKey.length,
    keyPrefix: apiKey.substring(0, 30) + '...',
    keySuffix: '...' + apiKey.substring(apiKey.length - 20),
    keyFirst30: apiKey.substring(0, 30),
    keyLast30: apiKey.substring(apiKey.length - 30),
    keyStartsWith: apiKey.startsWith('sk-proj-'),
    keyEndsWith: apiKey.endsWith('ULL4_mmoA') ? '...ULL4_mmoA ✅' : `...${apiKey.substring(apiKey.length - 10)} ❌`
  };
  console.log('🔑 Creating OpenAI client with key:', JSON.stringify(keyInfo, null, 2));

  // Recreate client to ensure fresh key is used
  const client = new OpenAI({
    apiKey: apiKey,
  });
  
  console.log('✅ OpenAI client created successfully');
  return client;
}

class OpenAIService {
  async generateEmailResponse(emailContent, style = 'brief', mode = 'response') {
    try {
      // Verify API key before making request
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        console.error('❌ OPENAI_API_KEY is missing or empty');
        return {
          success: false,
          error: 'OpenAI API key is not configured'
        };
      }

      console.log('🔑 API Key Check:', {
        hasKey: !!apiKey,
        keyLength: apiKey.length,
        keyPrefix: apiKey.substring(0, 15) + '...',
        keySuffix: '...' + apiKey.substring(apiKey.length - 10)
      });

      const prompt = mode === 'compose' ? 
        this.buildComposePrompt(emailContent, style) : 
        this.buildResponsePrompt(emailContent, style);
      
      console.log('📤 Sending request to OpenAI:', {
        model: 'gpt-4o-mini',
        promptLength: prompt.length,
        mode: mode
      });

      // Get fresh OpenAI client with current API key
      const openai = getOpenAIClient();

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini', // Using gpt-4o-mini for better availability and cost
        messages: [
          {
            role: 'system',
            content: mode === 'compose' ? 
              'You are an AI assistant that helps write professional emails from scratch. Always respond with valid JSON containing summary, responses, and actions.' :
              'You are an AI assistant that helps write professional email responses. Always respond with valid JSON containing summary, responses, and actions.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 800,
        temperature: 0.7,
      });

      console.log('✅ OpenAI response received:', {
        hasContent: !!response.choices[0]?.message?.content,
        tokensUsed: response.usage?.total_tokens
      });

      return {
        success: true,
        response: response.choices[0].message.content,
        tokensUsed: response.usage.total_tokens,
        cost: this.calculateCost(response.usage)
      };
    } catch (error) {
      console.error('OpenAI API Error:', error);
      console.error('OpenAI API Error Details:', {
        message: error.message,
        status: error.status,
        code: error.code,
        type: error.type,
        hasApiKey: !!process.env.OPENAI_API_KEY,
        apiKeyPrefix: process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.substring(0, 10) + '...' : 'MISSING'
      });
      return {
        success: false,
        error: error.message || 'Unknown OpenAI API error'
      };
    }
  }

  buildResponsePrompt(emailContent, style) {
    return `
Analyze this email and generate response suggestions in ${style} style:

Email: "${emailContent.body}"
From: ${emailContent.sender}
Subject: ${emailContent.subject}

Respond with JSON in this exact format:
{
  "summary": "Brief summary of the email",
  "responses": [
    {
      "label": "Response Type",
      "text": "Full response text"
    }
  ],
  "actions": ["action item 1", "action item 2"]
}
    `;
  }

  buildComposePrompt(emailContent, style) {
    const recipient = emailContent.recipient || 'the recipient';
    const description = emailContent.description || 'the email content';
    
    return `
Write a professional email in ${style} style based on this description:

What to write: "${description}"
Recipient: ${recipient}

Generate a complete email with subject line and body. Respond with JSON in this exact format:
{
  "summary": "Brief description of what the email is about",
  "responses": [
    {
      "label": "Subject Line",
      "text": "Email subject line"
    },
    {
      "label": "Email Body",
      "text": "Complete email body text"
    }
  ],
  "actions": ["Send email", "Review before sending", "Add recipient"]
}
    `;
  }

  // Keep the old method for backward compatibility
  buildPrompt(emailContent, style) {
    return this.buildResponsePrompt(emailContent, style);
  }

  calculateCost(usage) {
    const inputCost = (usage.prompt_tokens / 1000) * 0.01;
    const outputCost = (usage.completion_tokens / 1000) * 0.03;
    return inputCost + outputCost;
  }

  // ---- Post-generation quality gate ----

  static BANNED_PHRASES = [
    'extensive experience',
    'compelling candidate',
    'exciting opportunity',
    'impressive background',
    'strong candidate',
    'invaluable',
    'would be an asset',
    'i was impressed by',
    'caught my eye',
    'stood out',
    'i came across your profile',
    'i admire',
    'passionate about',
    'thrilled',
    'makes you an ideal',
    'your mission',
    'resonates',
    "in today's landscape",
    'your leadership in',
    'your vision',
  ];

  checkDraftQuality(draft) {
    if (!draft || typeof draft !== 'string') {
      return { pass: false, check: 'empty', reason: 'Draft is empty or not a string' };
    }

    const trimmed = draft.trim();

    // Check 1: Minimum length
    if (trimmed.length < 40) {
      return { pass: false, check: 'min_length', reason: `Draft too short (${trimmed.length} chars)` };
    }

    // Check 2: Completeness (ends with terminal punctuation)
    // Strip common sign-off noise that models append (placeholders, signature blocks)
    // Use [\s\S] instead of .* to match across newlines
    let cleaned = trimmed
      .replace(/\n*(?:Best regards|Kind regards|Warm regards|Regards|Sincerely|Best wishes|Best|Cheers|Thanks|Thank you),?\s*[\s\S]*$/i, '')
      .replace(/\n*\[(?:Your|My)[\s\S]*$/i, '')
      .replace(/^Subject:.*\n+/i, '')
      .trim();
    if (cleaned.length < 40) cleaned = trimmed; // Don't over-strip

    const lastChar = cleaned.slice(-1);
    const terminalChars = '.!?';
    const closingThenTerminal = /[.!?]["')\]]\s*$/;
    if (!terminalChars.includes(lastChar) && !closingThenTerminal.test(cleaned)) {
      return { pass: false, check: 'completeness', reason: `Draft appears truncated (ends with "${cleaned.slice(-20)}")` };
    }

    // Check 3: Banned phrases
    const lower = trimmed.toLowerCase();
    for (const phrase of OpenAIService.BANNED_PHRASES) {
      if (lower.includes(phrase)) {
        return { pass: false, check: 'banned_phrase', reason: `Contains banned phrase: "${phrase}"` };
      }
    }

    return { pass: true };
  }

  /**
   * Generate with quality gate: runs checks, retries once on failure, falls back to safe generic.
   * @param {string} prompt - The generation prompt
   * @param {object} opts - Options: { fallbackName, fallbackContext, maxTokens }
   */
  async generateWithQualityGate(prompt, opts = {}) {
    const maxTokens = opts.maxTokens || 1000;

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.generateRaw(prompt, maxTokens);
      if (!result.success) {
        console.error(`[QualityGate] Generation failed (attempt ${attempt + 1}):`, result.error);
        continue;
      }

      const draft = result.response.trim();
      const check = this.checkDraftQuality(draft);

      if (check.pass) {
        if (attempt > 0) {
          console.log('[QualityGate] Retry succeeded');
        }
        return { success: true, response: draft, retried: attempt > 0 };
      }

      console.warn(`[QualityGate] Check failed (attempt ${attempt + 1}): [${check.check}] ${check.reason}`);

      if (attempt === 0) {
        console.log('[QualityGate] Retrying generation...');
      }
    }

    // Both attempts failed — fall back to safe generic message
    const name = opts.fallbackName || 'there';
    const context = opts.fallbackContext || '';
    const fallback = context
      ? `Hi ${name}, I wanted to reach out regarding ${context}. Would you have time for a brief conversation this week?`
      : `Hi ${name}, I wanted to reach out and connect. Would you have time for a brief conversation this week?`;

    console.warn('[QualityGate] Both attempts failed, using fallback. Last failure logged above.');
    return { success: true, response: fallback, fallback: true };
  }

  /**
   * Generate raw text response from a custom prompt
   */
  async generateRaw(prompt, maxTokens) {
    try {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        return { success: false, error: 'OpenAI API key is not configured' };
      }

      console.log('📤 Sending raw prompt to OpenAI, length:', prompt.length);

      const openai = getOpenAIClient();

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: maxTokens || 1000,
        temperature: 0.7,
      });

      console.log('✅ OpenAI raw response received:', {
        hasContent: !!response.choices[0]?.message?.content,
        tokensUsed: response.usage?.total_tokens
      });

      return {
        success: true,
        response: response.choices[0].message.content,
        tokensUsed: response.usage?.total_tokens
      };
    } catch (error) {
      console.error('OpenAI generateRaw error:', error.message);
      return {
        success: false,
        error: error.message || 'Unknown OpenAI API error'
      };
    }
  }
}

module.exports = new OpenAIService();
