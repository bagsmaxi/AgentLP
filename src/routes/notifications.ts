import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { logger } from '../utils/logger';

export const notificationsRouter = Router();

/**
 * GET /api/notifications?wallet=<address>&unreadOnly=true
 * Returns notifications for a wallet, newest first.
 */
notificationsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const wallet = req.query.wallet as string;
    if (!wallet) {
      res.status(400).json({ success: false, error: 'wallet query param required' });
      return;
    }

    const unreadOnly = req.query.unreadOnly === 'true';

    const notifications = await prisma.notification.findMany({
      where: {
        walletAddress: wallet,
        ...(unreadOnly ? { read: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({ success: true, data: notifications });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /api/notifications/unread-count?wallet=<address>
 * Returns the count of unread notifications.
 */
notificationsRouter.get('/unread-count', async (req: Request, res: Response) => {
  try {
    const wallet = req.query.wallet as string;
    if (!wallet) {
      res.status(400).json({ success: false, error: 'wallet query param required' });
      return;
    }

    const count = await prisma.notification.count({
      where: { walletAddress: wallet, read: false },
    });

    res.json({ success: true, data: { count } });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /api/notifications/:id/read
 * Mark a single notification as read.
 */
notificationsRouter.post('/:id/read', async (req: Request, res: Response) => {
  try {
    await prisma.notification.update({
      where: { id: req.params.id },
      data: { read: true },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /api/notifications/read-all
 * Mark all notifications as read for a wallet.
 * Body: { walletAddress: string }
 */
notificationsRouter.post('/read-all', async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress) {
      res.status(400).json({ success: false, error: 'walletAddress is required' });
      return;
    }

    await prisma.notification.updateMany({
      where: { walletAddress, read: false },
      data: { read: true },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * Helper: Create a notification (used internally by position monitor).
 */
export async function createNotification(params: {
  walletAddress: string;
  type: string;
  title: string;
  message: string;
  positionId?: string;
  actionType?: string;
}): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        walletAddress: params.walletAddress,
        type: params.type,
        title: params.title,
        message: params.message,
        positionId: params.positionId,
        actionType: params.actionType,
      },
    });
    logger.info('Notification created', { type: params.type, wallet: params.walletAddress });
  } catch (err) {
    logger.error('Failed to create notification', { error: (err as Error).message });
  }
}
