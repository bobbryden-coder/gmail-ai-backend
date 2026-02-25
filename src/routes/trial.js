const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/trial/status - Get trial status for authenticated user
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        isPremium: true,
        trialActive: true,
        trialStartDate: true,
        trialEndDate: true,
        subscriptionStatus: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        planType: true,
        createdAt: true,
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Calculate days remaining for trial
    let daysRemaining = 0;
    const isTrialing = user.subscriptionStatus === 'trialing' || user.trialActive;
    
    if (isTrialing && user.trialEndDate) {
      const now = new Date();
      const trialEnd = new Date(user.trialEndDate);
      daysRemaining = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
    }

    // Check if user is on freemium plan
    const isFreemium = user.subscriptionStatus === 'freemium';
    const isActive = user.subscriptionStatus === 'active';
    const hasFullAccess = isTrialing || isActive || user.isPremium;
    const isLimitedUser = !hasFullAccess;

    // For limited users, get today's usage count
    let dailyUsage = { used: 0, limit: 5, remaining: 5 };
    
    if (isLimitedUser) {
      const today = new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      
      const summariesUsedToday = await prisma.summaryLog.count({
        where: {
          userId: user.id,
          createdAt: { gte: todayStart }
        }
      });
      
      dailyUsage = {
        used: summariesUsedToday,
        limit: 5,
        remaining: Math.max(0, 5 - summariesUsedToday)
      };
    }

    // Determine requires_payment (for users who haven't started trial yet)
    const requiresPayment = !isTrialing && 
                           !isActive && 
                           !isFreemium &&
                           user.subscriptionStatus === 'pending_payment';

    res.json({
      success: true,
      user_id: user.id,
      email: user.email,
      
      // Trial info
      is_trialing: isTrialing,
      trial_active: isTrialing,
      trial_start_date: user.trialStartDate,
      trial_end_date: user.trialEndDate,
      days_remaining: daysRemaining,
      total_trial_days: 30,
      
      // Subscription info
      subscription_status: user.subscriptionStatus,
      is_premium: user.isPremium || hasFullAccess,
      is_freemium: isFreemium,
      is_active: isActive,
      has_full_access: hasFullAccess,
      plan_type: user.planType,
      has_subscription: !!user.stripeSubscriptionId,
      
      // Usage info (for limited users)
      daily_limit: isLimitedUser ? 5 : (hasFullAccess ? 100 : 5),
      summaries_used_today: dailyUsage.used,
      summaries_remaining: dailyUsage.remaining,
      usage_message: isLimitedUser 
        ? `${dailyUsage.remaining} of ${dailyUsage.limit} summaries remaining today`
        : (hasFullAccess ? 'Unlimited access' : null),
      
      // Stripe IDs
      stripe_customer_id: user.stripeCustomerId,
      stripe_subscription_id: user.stripeSubscriptionId,
      
      // Payment requirement
      requires_payment: requiresPayment,
      
      // Upgrade info for freemium users
      ...(isFreemium ? {
        upgrade_benefits: [
          'Unlimited AI summaries',
          'Unlimited compose & reply',
          'Advanced context options',
          'Custom writing styles',
          'Priority support'
        ],
        upgrade_url: process.env.UPGRADE_URL || 'https://gmail-ai-backend.vercel.app/pricing'
      } : {})
    });
  } catch (error) {
    console.error('Trial status error:', error);
    res.status(500).json({ error: 'Failed to get trial status' });
  }
});

module.exports = router;
