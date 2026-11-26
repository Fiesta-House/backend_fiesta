import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller';
import { mpesaCallbackGuard } from '../middleware/mpesa-callback-guard';
import { mpesaCallbackLimiter } from '../middleware/rate-limiters';

const router = Router();

// Safaricom M-Pesa Callback.
// Register MPESA_CALLBACK_URL as .../api/mpesa/callback/<MPESA_CALLBACK_SECRET>.
// The bare /callback path stays mounted so that, once a secret is configured,
// callers without it get a clean rejection from the guard instead of falling
// through to the admin-auth middleware.
const handleCallback = paymentController.handleMpesaCallback.bind(paymentController);
router.post('/callback/:secret', mpesaCallbackLimiter, mpesaCallbackGuard, handleCallback);
router.post('/callback', mpesaCallbackLimiter, mpesaCallbackGuard, handleCallback);

export default router;
