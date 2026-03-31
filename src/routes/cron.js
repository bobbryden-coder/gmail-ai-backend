const express = require('express');
const { PrismaClient } = require('@prisma/client');
const Stripe = require('stripe');

const router = express.Router();
const prisma = new PrismaClient();

// Verify cron secret for security
function verifyCronSecret(req, res, next) {
  const cronSecret = req.headers['x-cron-secret'] || req.query.secret;
  
  if (!process.env.CRON_SECRET) {
    console.error('CRON_SECRET not configured');
    return res.status(500).json({ error: 'Cron not configured' });
  }
  
  if (cronSecret !== process.env.CRON_SECRET) {
    console.error('Invalid cron secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
}

// POST /api/cron/check-trial-expiry
// Runs daily to find expired trials and convert them to freemium (NOT charge them)
router.post('/check-trial-expiry', verifyCronSecret, async (req, res) => {
  try {
    console.log('🕐 Starting trial expiry check (freemium conversion)...');
    
    const now = new Date();
    
    // Find all users with expired trials who are still in trialing status
    const expiredTrialUsers = await prisma.user.findMany({
      where: {
        OR: [
          { trialActive: true },
          { subscriptionStatus: 'trialing' }
        ],
        trialEndDate: {
          lte: now
        },
        // Don't touch users who already have active paid subscriptions
        subscriptionStatus: {
          notIn: ['active', 'freemium']
        }
      }
    });
    
    console.log(`Found ${expiredTrialUsers.length} users with expired trials to convert to freemium`);
    
    let converted = 0;
    let errors = [];
    
    for (const user of expiredTrialUsers) {
      try {
        console.log(`Converting user ${user.id} (${user.email}) to freemium`);
        
        // Convert to freemium - DO NOT create Stripe subscription or charge
        await prisma.user.update({
          where: { id: user.id },
          data: {
            trialActive: false,
            isPremium: false, // No longer premium - now freemium with limits
            subscriptionStatus: 'freemium',
          }
        });
        
        console.log(`✅ User ${user.email} converted to freemium`);
        converted++;
        
      } catch (userError) {
        console.error(`❌ Error converting user ${user.id}:`, userError.message);
        errors.push({ userId: user.id, email: user.email, error: userError.message });
      }
    }
    
    console.log(`🏁 Trial expiry check complete. Converted to freemium: ${converted}, Errors: ${errors.length}`);
    
    res.json({
      success: true,
      message: `Converted ${converted} users to freemium`,
      converted: converted,
      total: expiredTrialUsers.length,
      errors: errors.length > 0 ? errors : undefined
    });
    
  } catch (error) {
    console.error('❌ Trial expiry cron error:', error);
    res.status(500).json({ error: 'Failed to process trial expiries' });
  }
});

// GET /api/cron/check-trial-expiry - Called by Vercel Cron daily
router.get('/check-trial-expiry', verifyCronSecret, async (req, res) => {
  try {
    console.log('🕐 Starting trial expiry check (freemium conversion)...');

    const now = new Date();

    // Find all users with expired trials who are still in trialing status
    const expiredTrialUsers = await prisma.user.findMany({
      where: {
        OR: [
          { trialActive: true },
          { subscriptionStatus: 'trialing' }
        ],
        trialEndDate: {
          lte: now
        },
        // Don't touch users who already have active paid subscriptions
        subscriptionStatus: {
          notIn: ['active', 'freemium']
        }
      }
    });

    console.log(`Found ${expiredTrialUsers.length} users with expired trials to convert to freemium`);

    let converted = 0;
    let errors = [];

    for (const user of expiredTrialUsers) {
      try {
        console.log(`Converting user ${user.id} (${user.email}) to freemium`);

        // Convert to freemium - DO NOT create Stripe subscription or charge
        await prisma.user.update({
          where: { id: user.id },
          data: {
            trialActive: false,
            isPremium: false, // No longer premium - now freemium with limits
            subscriptionStatus: 'freemium',
          }
        });

        console.log(`✅ User ${user.email} converted to freemium`);
        converted++;

      } catch (userError) {
        console.error(`❌ Error converting user ${user.id}:`, userError.message);
        errors.push({ userId: user.id, email: user.email, error: userError.message });
      }
    }

    console.log(`🏁 Trial expiry check complete. Converted to freemium: ${converted}, Errors: ${errors.length}`);

    res.json({
      success: true,
      message: `Converted ${converted} users to freemium`,
      converted: converted,
      total: expiredTrialUsers.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('❌ Trial expiry cron error:', error);
    res.status(500).json({ error: 'Failed to process trial expiries' });
  }
});

module.exports = router;
