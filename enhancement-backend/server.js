require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const IRCTC_BASE = process.env.MOCK_IRCTC_URL || 'http://localhost:4001/irctc/v1';

// Helper: Fetch from Mock IRCTC with 3.5s timeout (enforces FR 17 & FR 18)
const irctcClient = axios.create({
  baseURL: IRCTC_BASE,
  timeout: 3500,
});

// Helper: Clean expired berth locks automatically
async function purgeExpiredLocks(client = pool) {
  await client.query(`DELETE FROM berth_locks WHERE expires_at < NOW()`);
}

// Helper: Dynamic Pricing & Senior Citizen Concession Engine (FR 7, 9, 10)
function calculateFareDetails(baseFare, occupancyPct, passengerAge, passengerGender, rules) {
  let surgeMultiplier = 1.0;
  let demandLevel = 'NORMAL';

  if (occupancyPct >= rules.medium_demand_threshold) {
    surgeMultiplier = parseFloat(rules.high_demand_multiplier);
    demandLevel = 'HIGH';
  } else if (occupancyPct >= rules.low_demand_threshold) {
    surgeMultiplier = parseFloat(rules.medium_demand_multiplier);
    demandLevel = 'MODERATE';
  }

  const demandSurcharge = Math.round(baseFare * (surgeMultiplier - 1));
  const fareAfterSurge = baseFare + demandSurcharge;

  // Check Senior Citizen Eligibility
  const isSeniorMale = passengerGender === 'M' && passengerAge >= rules.senior_male_min_age;
  const isSeniorFemale = passengerGender === 'F' && passengerAge >= rules.senior_female_min_age;
  const isSeniorOther = passengerGender === 'O' && passengerAge >= rules.senior_male_min_age;
  const isSeniorEligible = isSeniorMale || isSeniorFemale || isSeniorOther;

  const concessionPct = isSeniorEligible ? parseFloat(rules.senior_concession_pct) : 0;
  const seniorConcession = Math.round((fareAfterSurge * concessionPct) / 100);
  const totalPayable = fareAfterSurge - seniorConcession;

  return {
    baseFare,
    demandLevel,
    occupancyPercentage: occupancyPct,
    surgeMultiplier,
    demandSurcharge,
    isSeniorEligible,
    concessionPercentage: concessionPct,
    seniorConcession,
    totalPayable,
  };
}

// ============================================================================
// 1. AUTH & ROLE-BASED ACCESS (Section 5.3)
// ============================================================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query(
      'SELECT id, name, email, age, gender, role FROM users WHERE email = $1 AND password_hash = $2',
      [email, password]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, age, gender } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, age, gender, role)
       VALUES ($1, $2, $3, $4, $5, 'passenger')
       RETURNING id, name, email, age, gender, role`,
      [name, email, password, age, gender]
    );
    res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Email already registered or invalid input.' });
  }
});

// ============================================================================
// 2. SEARCH TRAINS & INTELLIGENT AVAILABILITY (FR 1–4, 8, 11–13, 15–18)
// ============================================================================
app.get('/api/trains', async (req, res) => {
  try {
    const response = await irctcClient.get('/trains', { params: req.query });
    res.json(response.data);
  } catch (err) {
    const isTimeout = err.code === 'ECONNABORTED';
    res.status(503).json({
      success: false,
      error: isTimeout ? 'IRCTC_TIMEOUT' : 'IRCTC_SERVICE_ERROR',
      message: isTimeout
        ? 'IRCTC server took too long to respond. Please retry.'
        : 'Unable to fetch trains from authorized IRCTC service.',
    });
  }
});

app.get('/api/trains/:trainNumber/availability', async (req, res) => {
  const { trainNumber } = req.params;
  const { sessionId, fail, delay } = req.query;

  try {
    await purgeExpiredLocks();

    // 1. Fetch live raw data from Mock IRCTC
    const irctcRes = await irctcClient.get(`/trains/${trainNumber}/availability`, {
      params: { fail, delay },
    });
    const trainData = irctcRes.data;

    // 2. Fetch active temporary locks from PostgreSQL
    const lockRes = await pool.query(
      'SELECT coach_id, berth_id, user_session_id, expires_at FROM berth_locks WHERE train_number = $1',
      [trainNumber]
    );
    const activeLocks = lockRes.rows;

    // 3. Fetch current pricing rules
    const rulesRes = await pool.query('SELECT * FROM pricing_rules WHERE id = 1');
    const rules = rulesRes.rows[0];

    // 4. Merge IRCTC availability + active locks + dynamic surge pricing + lower-berth flags
    const enhancedCoaches = trainData.coaches.map((coach) => {
      const sampleFare = calculateFareDetails(coach.baseFare, coach.occupancyPercentage, 30, 'M', rules);

      const enhancedBerths = coach.berths.map((berth) => {
        const lock = activeLocks.find(
          (l) => l.coach_id === coach.coachId && l.berth_id === berth.berthId
        );

        let effectiveStatus = berth.status; // AVAILABLE or BOOKED
        if (effectiveStatus === 'AVAILABLE' && lock) {
          effectiveStatus = lock.user_session_id === sessionId ? 'LOCKED_BY_YOU' : 'LOCKED_BY_OTHER';
        }

        const isLowerBerth = berth.berthType === 'LB' || berth.berthType === 'SL';

        return {
          ...berth,
          effectiveStatus,
          isSeniorRecommended: effectiveStatus === 'AVAILABLE' && isLowerBerth,
        };
      });

      const recommendedLowerBerths = enhancedBerths
        .filter((b) => b.isSeniorRecommended)
        .map((b) => b.berthId);

      return {
        ...coach,
        dynamicFarePreview: sampleFare.baseFare + sampleFare.demandSurcharge,
        demandLevel: sampleFare.demandLevel,
        surgeMultiplier: sampleFare.surgeMultiplier,
        recommendedLowerBerths,
        berths: enhancedBerths,
      };
    });

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      trainNumber: trainData.trainNumber,
      trainName: trainData.trainName,
      source: trainData.source,
      destination: trainData.destination,
      departureTime: trainData.departureTime,
      arrivalTime: trainData.arrivalTime,
      coaches: enhancedCoaches,
    });
  } catch (err) {
    const isTimeout = err.code === 'ECONNABORTED';
    res.status(503).json({
      success: false,
      error: isTimeout ? 'IRCTC_TIMEOUT' : 'IRCTC_API_FAILURE',
      message: isTimeout
        ? 'Real-time availability request timed out (>3.5s). Click Retry.'
        : 'IRCTC upstream service unavailable. Please try again shortly.',
    });
  }
});

// ============================================================================
// 3. CONCURRENT BERTH LOCKING (FR 5 & FR 14 — Prevents Race Conditions)
// ============================================================================
app.post('/api/berths/lock', async (req, res) => {
  const { trainNumber, coachId, berthId, sessionId } = req.body;
  if (!trainNumber || !coachId || !berthId || !sessionId) {
    return res.status(400).json({ success: false, message: 'Missing required lock parameters.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await purgeExpiredLocks(client);

    const existing = await client.query(
      `SELECT * FROM berth_locks
       WHERE train_number = $1 AND coach_id = $2 AND berth_id = $3
       FOR UPDATE`,
      [trainNumber, coachId, berthId]
    );

    if (existing.rows.length > 0) {
      const lock = existing.rows[0];
      if (lock.user_session_id !== sessionId) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: 'BERTH_CONFLICT',
          message: `Berth ${berthId} was just selected by another passenger. Please choose another berth.`,
        });
      }
      await client.query(
        `UPDATE berth_locks SET expires_at = NOW() + INTERVAL '5 minutes' WHERE lock_id = $1`,
        [lock.lock_id]
      );
    } else {
      await client.query('DELETE FROM berth_locks WHERE user_session_id = $1', [sessionId]);

      await client.query(
        `INSERT INTO berth_locks (train_number, coach_id, berth_id, user_session_id, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '5 minutes')`,
        [trainNumber, coachId, berthId, sessionId]
      );
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Berth ${berthId} locked for 5 minutes.`,
      lockedBerth: { trainNumber, coachId, berthId },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(409).json({
      success: false,
      error: 'BERTH_CONFLICT',
      message: 'Berth is no longer available. Please select another.',
    });
  } finally {
    client.release();
  }
});

// ============================================================================
// 4. FARE BREAKUP & SENIOR CONCESSION PREVIEW (FR 6, 7, 9, 10)
// ============================================================================
app.post('/api/fare/calculate', async (req, res) => {
  const { baseFare, occupancyPercentage, passengerAge, passengerGender } = req.body;
  try {
    const rulesRes = await pool.query('SELECT * FROM pricing_rules WHERE id = 1');
    const breakdown = calculateFareDetails(
      Number(baseFare),
      Number(occupancyPercentage),
      Number(passengerAge),
      passengerGender,
      rulesRes.rows[0]
    );
    res.json({ success: true, breakdown });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to calculate fare breakup.' });
  }
});

// ============================================================================
// 5. FINAL BOOKING CONFIRMATION (Commits to IRCTC Mock + Local DB)
// ============================================================================
app.post('/api/bookings/confirm', async (req, res) => {
  const { trainNumber, coachId, berthId, sessionId, passenger } = req.body;

  const client = await pool.connect();
  try {
    await purgeExpiredLocks(client);

    // 1. Verify user still holds the lock
    const lockCheck = await client.query(
      `SELECT * FROM berth_locks
       WHERE train_number = $1 AND coach_id = $2 AND berth_id = $3 AND user_session_id = $4`,
      [trainNumber, coachId, berthId, sessionId]
    );

    if (lockCheck.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: 'Your seat lock expired or was not found. Please select the berth again.',
      });
    }

    // 2. Re-fetch latest IRCTC coach occupancy & base fare (Safety Requirement 5.2)
    const irctcRes = await irctcClient.get(`/trains/${trainNumber}/availability`);
    const coach = irctcRes.data.coaches.find((c) => c.coachId === coachId);
    const rulesRes = await client.query('SELECT * FROM pricing_rules WHERE id = 1');

    const fare = calculateFareDetails(
      coach.baseFare,
      coach.occupancyPercentage,
      Number(passenger.age),
      passenger.gender,
      rulesRes.rows[0]
    );

    // 3. Commit booking to Mock IRCTC Core API
    const commitRes = await irctcClient.post('/bookings/commit', {
      trainNumber,
      coachId,
      berthId,
      passenger,
      finalFarePaid: fare.totalPayable,
    });

    const pnr = commitRes.data.ticket.pnr;

    // 4. Save audit record in PostgreSQL & remove lock
    await client.query(
      `INSERT INTO bookings
       (pnr, train_number, coach_id, berth_id, passenger_name, passenger_age, passenger_gender, base_fare, surge_amount, concession_amount, final_fare)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        pnr,
        trainNumber,
        coachId,
        berthId,
        passenger.name,
        passenger.age,
        passenger.gender,
        fare.baseFare,
        fare.demandSurcharge,
        fare.seniorConcession,
        fare.totalPayable,
      ]
    );

    await client.query('DELETE FROM berth_locks WHERE lock_id = $1', [lockCheck.rows[0].lock_id]);

    res.status(201).json({
      success: true,
      ticket: commitRes.data.ticket,
      fareBreakdown: fare,
    });
  } catch (err) {
    res.status(502).json({
      success: false,
      message: err.response?.data?.message || 'Failed to confirm booking with IRCTC service.',
    });
  } finally {
    client.release();
  }
});

// ============================================================================
// 6. ADMIN PRICING & CONCESSION CONFIGURATION (Section 2.3)
// ============================================================================
app.get('/api/admin/pricing-rules', async (req, res) => {
  const result = await pool.query('SELECT * FROM pricing_rules WHERE id = 1');
  res.json({ success: true, rules: result.rows[0] });
});

app.put('/api/admin/pricing-rules', async (req, res) => {
  const {
    low_demand_threshold,
    medium_demand_threshold,
    medium_demand_multiplier,
    high_demand_multiplier,
    senior_male_min_age,
    senior_female_min_age,
    senior_concession_pct,
  } = req.body;

  const result = await pool.query(
    `UPDATE pricing_rules SET
      low_demand_threshold = COALESCE($1, low_demand_threshold),
      medium_demand_threshold = COALESCE($2, medium_demand_threshold),
      medium_demand_multiplier = COALESCE($3, medium_demand_multiplier),
      high_demand_multiplier = COALESCE($4, high_demand_multiplier),
      senior_male_min_age = COALESCE($5, senior_male_min_age),
      senior_female_min_age = COALESCE($6, senior_female_min_age),
      senior_concession_pct = COALESCE($7, senior_concession_pct),
      updated_at = NOW()
     WHERE id = 1 RETURNING *`,
    [
      low_demand_threshold,
      medium_demand_threshold,
      medium_demand_multiplier,
      high_demand_multiplier,
      senior_male_min_age,
      senior_female_min_age,
      senior_concession_pct,
    ]
  );

  res.json({ success: true, rules: result.rows[0] });
});

// ============================================================================
// START SERVER
// ============================================================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Enhancement Backend running on http://localhost:${PORT}`);
});