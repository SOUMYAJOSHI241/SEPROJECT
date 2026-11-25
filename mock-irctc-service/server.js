const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================================
// 1. INITIAL DATA GENERATOR (Indian Railways Berth & Coach Layouts)
// ============================================================================

const COACH_CONFIGS = {
  '3A': { totalBerths: 24, layout: ['LB', 'MB', 'UB', 'LB', 'MB', 'UB', 'SL', 'SU'] },
  '2A': { totalBerths: 18, layout: ['LB', 'UB', 'LB', 'UB', 'SL', 'SU'] },
  'SL': { totalBerths: 24, layout: ['LB', 'MB', 'UB', 'LB', 'MB', 'UB', 'SL', 'SU'] },
  'CC': { totalBerths: 20, layout: ['WS', 'MS', 'AS', 'AS', 'WS'] },
};

function generateBerths(coachId, coachClass, preBookedNumbers = []) {
  const config = COACH_CONFIGS[coachClass] || COACH_CONFIGS['3A'];
  const berths = [];

  for (let i = 1; i <= config.totalBerths; i++) {
    const isBooked = preBookedNumbers.includes(i);
    berths.push({
      berthId: `${coachId}-${i}`,
      berthNumber: i,
      berthType: config.layout[(i - 1) % config.layout.length],
      status: isBooked ? 'BOOKED' : 'AVAILABLE',
      passenger: isBooked ? { name: 'Seeded Passenger', age: 34, gender: 'M' } : null,
    });
  }
  return berths;
}

function getInitialTrainsState() {
  return {
    '12951': {
      trainNumber: '12951',
      trainName: 'Mumbai Central - New Delhi Rajdhani Express',
      source: 'MMCT',
      destination: 'NDLS',
      departureTime: '17:00',
      arrivalTime: '08:32',
      duration: '15h 32m',
      coaches: [
        {
          coachId: 'B1',
          coachClass: '3A',
          baseFare: 1850,
          berths: generateBerths('B1', '3A', [2, 3, 5, 6, 8, 10, 11, 14, 15, 18, 20, 22]), // ~50% occupied
        },
        {
          coachId: 'B2',
          coachClass: '3A',
          baseFare: 1850,
          // High occupancy (~83%) — ideal for testing Dynamic Surge Pricing immediately
          berths: generateBerths('B2', '3A', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 24]),
        },
        {
          coachId: 'A1',
          coachClass: '2A',
          baseFare: 2650,
          berths: generateBerths('A1', '2A', [2, 4, 6, 12]),
        },
      ],
    },
    '12955': {
      trainNumber: '12955',
      trainName: 'Mumbai Central - Jaipur Superfast Express',
      source: 'MMCT',
      destination: 'JP',
      departureTime: '19:05',
      arrivalTime: '12:45',
      duration: '17h 40m',
      coaches: [
        {
          coachId: 'S1',
          coachClass: 'SL',
          baseFare: 540,
          berths: generateBerths('S1', 'SL', [3, 6, 9, 12, 15]),
        },
        {
          coachId: 'B1',
          coachClass: '3A',
          baseFare: 1420,
          berths: generateBerths('B1', '3A', [1, 4, 7, 10, 13, 16]),
        },
      ],
    },
    '12009': {
      trainNumber: '12009',
      trainName: 'Mumbai Central - Ahmedabad Shatabdi Express',
      source: 'MMCT',
      destination: 'ADI',
      departureTime: '06:40',
      arrivalTime: '13:05',
      duration: '06h 25m',
      coaches: [
        {
          coachId: 'C1',
          coachClass: 'CC',
          baseFare: 1120,
          berths: generateBerths('C1', 'CC', [2, 5, 8, 11, 14, 17]),
        },
      ],
    },
  };
}

let trainsDB = getInitialTrainsState();
let pnrRecords = {};

// ============================================================================
// 2. REQUEST LOGGER & CHAOS SIMULATION MIDDLEWARE (FR 17 & FR 18 Testing)
// ============================================================================
// Query flags supported on ANY endpoint:
//   ?delay=4000   -> Delays response by 4000ms (tests timeout handling)
//   ?fail=true    -> Forces HTTP 503 Service Unavailable (tests API failure handling)

app.use((req, res, next) => {
  const delayMs = Math.min(parseInt(req.query.delay, 10) || 0, 15000);
  const shouldFail = req.query.fail === 'true';

  console.log(`[IRCTC-MOCK] ${req.method} ${req.originalUrl}`);

  setTimeout(() => {
    if (shouldFail) {
      return res.status(503).json({
        source: 'IRCTC_CORE_MOCK',
        success: false,
        error: 'IRCTC_UPSTREAM_UNAVAILABLE',
        message: 'Authorized IRCTC server is temporarily unreachable. Please retry.',
      });
    }
    next();
  }, delayMs);
});

// ============================================================================
// 3. HELPER FUNCTIONS
// ============================================================================

function computeCoachMetrics(coach) {
  const totalBerths = coach.berths.length;
  const bookedBerths = coach.berths.filter((b) => b.status === 'BOOKED').length;
  const availableBerths = totalBerths - bookedBerths;
  const availableLowerBerths = coach.berths.filter(
    (b) => b.status === 'AVAILABLE' && (b.berthType === 'LB' || b.berthType === 'SL')
  ).length;

  return {
    coachId: coach.coachId,
    coachClass: coach.coachClass,
    baseFare: coach.baseFare,
    totalBerths,
    bookedBerths,
    availableBerths,
    availableLowerBerths,
    occupancyPercentage: Math.round((bookedBerths / totalBerths) * 100),
    berths: coach.berths,
  };
}

function generatePNR() {
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

// ============================================================================
// 4. MOCK IRCTC REST API ENDPOINTS
// ============================================================================

// Health check
app.get('/irctc/v1/health', (req, res) => {
  res.json({
    source: 'IRCTC_CORE_MOCK',
    status: 'ONLINE',
    timestamp: new Date().toISOString(),
  });
});

// Search trains (optional query params: ?source=MMCT&destination=NDLS)
app.get('/irctc/v1/trains', (req, res) => {
  const { source, destination } = req.query;
  let results = Object.values(trainsDB);

  if (source) {
    results = results.filter((t) => t.source.toLowerCase() === source.toLowerCase());
  }
  if (destination) {
    results = results.filter((t) => t.destination.toLowerCase() === destination.toLowerCase());
  }

  const formatted = results.map((train) => ({
    trainNumber: train.trainNumber,
    trainName: train.trainName,
    source: train.source,
    destination: train.destination,
    departureTime: train.departureTime,
    arrivalTime: train.arrivalTime,
    duration: train.duration,
    classesAvailable: [...new Set(train.coaches.map((c) => c.coachClass))],
  }));

  res.json({
    source: 'IRCTC_CORE_MOCK',
    success: true,
    count: formatted.length,
    trains: formatted,
  });
});

// Get full coach & berth availability + base fares for a specific train
app.get('/irctc/v1/trains/:trainNumber/availability', (req, res) => {
  const train = trainsDB[req.params.trainNumber];
  if (!train) {
    return res.status(404).json({
      source: 'IRCTC_CORE_MOCK',
      success: false,
      error: 'TRAIN_NOT_FOUND',
      message: `No train found with number ${req.params.trainNumber}`,
    });
  }

  const coaches = train.coaches.map(computeCoachMetrics);
  const totalSeats = coaches.reduce((sum, c) => sum + c.totalBerths, 0);
  const totalBooked = coaches.reduce((sum, c) => sum + c.bookedBerths, 0);

  res.json({
    source: 'IRCTC_CORE_MOCK',
    success: true,
    timestamp: new Date().toISOString(),
    trainNumber: train.trainNumber,
    trainName: train.trainName,
    source: train.source,
    destination: train.destination,
    departureTime: train.departureTime,
    arrivalTime: train.arrivalTime,
    overallOccupancyPercentage: Math.round((totalBooked / totalSeats) * 100),
    coaches,
  });
});

// Commit final booking (called by your Enhancement Backend after berth lock & payment)
// Body: { trainNumber, coachId, berthId, journeyDate, passenger: { name, age, gender }, finalFarePaid }
app.post('/irctc/v1/bookings/commit', (req, res) => {
  const { trainNumber, coachId, berthId, journeyDate, passenger, finalFarePaid } = req.body;

  if (!trainNumber || !coachId || !berthId || !passenger?.name) {
    return res.status(400).json({
      source: 'IRCTC_CORE_MOCK',
      success: false,
      error: 'INVALID_PAYLOAD',
      message: 'trainNumber, coachId, berthId, and passenger.name are required.',
    });
  }

  const train = trainsDB[trainNumber];
  if (!train) {
    return res.status(404).json({ source: 'IRCTC_CORE_MOCK', success: false, error: 'TRAIN_NOT_FOUND' });
  }

  const coach = train.coaches.find((c) => c.coachId === coachId);
  if (!coach) {
    return res.status(404).json({ source: 'IRCTC_CORE_MOCK', success: false, error: 'COACH_NOT_FOUND' });
  }

  const berth = coach.berths.find((b) => b.berthId === berthId);
  if (!berth) {
    return res.status(404).json({ source: 'IRCTC_CORE_MOCK', success: false, error: 'BERTH_NOT_FOUND' });
  }

  if (berth.status === 'BOOKED') {
    return res.status(409).json({
      source: 'IRCTC_CORE_MOCK',
      success: false,
      error: 'BERTH_ALREADY_BOOKED',
      message: `Berth ${berthId} is already confirmed in IRCTC core database.`,
    });
  }

  // Mark berth permanently booked
  berth.status = 'BOOKED';
  berth.passenger = {
    name: passenger.name,
    age: passenger.age || null,
    gender: passenger.gender || null,
  };

  const pnr = generatePNR();
  const ticket = {
    pnr,
    bookingStatus: 'CNF',
    trainNumber: train.trainNumber,
    trainName: train.trainName,
    source: train.source,
    destination: train.destination,
    journeyDate: journeyDate || new Date().toISOString().split('T')[0],
    coachId: coach.coachId,
    coachClass: coach.coachClass,
    berthId: berth.berthId,
    berthNumber: berth.berthNumber,
    berthType: berth.berthType,
    passenger: berth.passenger,
    baseFare: coach.baseFare,
    finalFarePaid: finalFarePaid ?? coach.baseFare,
    bookedAt: new Date().toISOString(),
  };

  pnrRecords[pnr] = ticket;

  res.status(201).json({
    source: 'IRCTC_CORE_MOCK',
    success: true,
    ticket,
  });
});

// Check PNR status
app.get('/irctc/v1/pnr/:pnr', (req, res) => {
  const ticket = pnrRecords[req.params.pnr];
  if (!ticket) {
    return res.status(404).json({
      source: 'IRCTC_CORE_MOCK',
      success: false,
      error: 'PNR_NOT_FOUND',
      message: 'Invalid or non-existent PNR number.',
    });
  }

  res.json({
    source: 'IRCTC_CORE_MOCK',
    success: true,
    ticket,
  });
});

// Cancel ticket by PNR (frees the berth back to AVAILABLE)
app.post('/irctc/v1/bookings/:pnr/cancel', (req, res) => {
  const ticket = pnrRecords[req.params.pnr];
  if (!ticket) {
    return res.status(404).json({ source: 'IRCTC_CORE_MOCK', success: false, error: 'PNR_NOT_FOUND' });
  }

  if (ticket.bookingStatus === 'CANCELLED') {
    return res.status(400).json({ source: 'IRCTC_CORE_MOCK', success: false, error: 'ALREADY_CANCELLED' });
  }

  const train = trainsDB[ticket.trainNumber];
  const coach = train?.coaches.find((c) => c.coachId === ticket.coachId);
  const berth = coach?.berths.find((b) => b.berthId === ticket.berthId);

  if (berth) {
    berth.status = 'AVAILABLE';
    berth.passenger = null;
  }

  ticket.bookingStatus = 'CANCELLED';
  ticket.cancelledAt = new Date().toISOString();

  res.json({
    source: 'IRCTC_CORE_MOCK',
    success: true,
    message: `PNR ${ticket.pnr} cancelled and berth ${ticket.berthId} released.`,
    ticket,
  });
});

// Reset entire Mock IRCTC state (useful between demo runs)
app.post('/irctc/v1/admin/reset', (req, res) => {
  trainsDB = getInitialTrainsState();
  pnrRecords = {};
  res.json({
    source: 'IRCTC_CORE_MOCK',
    success: true,
    message: 'All trains, berths, and PNR records reset to default demo state.',
  });
});

// ============================================================================
// 5. START SERVER
// ============================================================================
const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
  console.log(`=========================================================`);
  console.log(` Mock IRCTC Core API running at http://localhost:${PORT}`);
  console.log(`=========================================================`);
  console.log(` Endpoints:`);
  console.log(`  GET  /irctc/v1/trains`);
  console.log(`  GET  /irctc/v1/trains/12951/availability`);
  console.log(`  POST /irctc/v1/bookings/commit`);
  console.log(`  GET  /irctc/v1/pnr/:pnr`);
  console.log(`  POST /irctc/v1/bookings/:pnr/cancel`);
  console.log(`  POST /irctc/v1/admin/reset`);
  console.log(` Chaos Flags: ?fail=true | ?delay=5000`);
});