import { Router } from 'express';
import { bookingController } from '../controllers/booking.controller';

const router = Router();

router.get('/', bookingController.listBookings.bind(bookingController));
router.get('/drafts', bookingController.listBookingDrafts.bind(bookingController));
router.get('/by-id/:id', bookingController.getBookingById.bind(bookingController));
router.get('/packages', bookingController.getPackages.bind(bookingController));
router.post('/packages', bookingController.createPackage.bind(bookingController));
router.put('/packages/:id', bookingController.updatePackage.bind(bookingController));
router.delete('/packages/:id', bookingController.deletePackage.bind(bookingController));
router.get('/services', bookingController.getServices.bind(bookingController));
router.get('/available-hours/:date', bookingController.getAvailableHours.bind(bookingController));
router.put('/:id', bookingController.updateBooking.bind(bookingController));
router.post('/:id/confirm', bookingController.confirmBooking.bind(bookingController));
router.post('/:id/cancel', bookingController.cancelBooking.bind(bookingController));
router.get('/:customerId', bookingController.getCustomerBookings.bind(bookingController));


export default router;
