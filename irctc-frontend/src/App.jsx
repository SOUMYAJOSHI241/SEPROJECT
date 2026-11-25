import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import './App.css';

const API_BASE = 'http://localhost:4000/api';

// Unique session ID per browser tab so you can test concurrency across 2 tabs!
const SESSION_ID = 'sess_' + Math.random().toString(36).substring(2, 10);

export default function App() {
  const [view, setView] = useState('booking'); // 'booking' | 'admin'
  const [trains, setTrains] = useState([]);
  const [selectedTrain, setSelectedTrain] = useState('12951');
  const [availability, setAvailability] = useState(null);
  const [selectedCoachId, setSelectedCoachId] = useState('B1');
  const [lockedBerth, setLockedBerth] = useState(null);

  // Passenger & Senior Citizen Assist State
  const [passenger, setPassenger] = useState({ name: 'Ramesh Sharma', age: 64, gender: 'M' });
  const [seniorAssistActive, setSeniorAssistActive] = useState(true);
  const [fareBreakdown, setFareBreakdown] = useState(null);

  // Real-time sync & error handling state (FR 15–18)
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const [confirmedTicket, setConfirmedTicket] = useState(null);
  const [chaosFlag, setChaosFlag] = useState(''); // '' | 'fail=true' | 'delay=5000'

  // Admin Pricing Rules State
  const [rules, setRules] = useState(null);

  // 1. Fetch Train List
  useEffect(() => {
    axios.get(`${API_BASE}/trains`)
      .then((res) => setTrains(res.data.trains || []))
      .catch(() => setErrorMsg('Failed to load train directory from backend.'));
  }, []);

  // 2. Fetch Real-Time Coach & Berth Availability (FR 1, 2, 15, 16, 17, 18)
  const fetchAvailability = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const query = new URLSearchParams({ sessionId: SESSION_ID });
      if (chaosFlag === 'fail=true') query.append('fail', 'true');
      if (chaosFlag === 'delay=5000') query.append('delay', '5000');

      const res = await axios.get(`${API_BASE}/trains/${selectedTrain}/availability?${query.toString()}`);
      setAvailability(res.data);
      setErrorMsg(null);

      // Default to first coach if current coach isn't in new train
      if (res.data.coaches?.length > 0) {
        const exists = res.data.coaches.some((c) => c.coachId === selectedCoachId);
        if (!exists) setSelectedCoachId(res.data.coaches[0].coachId);
      }
    } catch (err) {
      setErrorMsg(err.response?.data?.message || 'IRCTC Service Timeout or Connection Error.');
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [selectedTrain, selectedCoachId, chaosFlag]);

  // Initial load + 4-second Real-Time Polling (meets < 5s SRS requirement)
  useEffect(() => {
    fetchAvailability(true);
    const interval = setInterval(() => {
      if (!chaosFlag) fetchAvailability(false);
    }, 4000);
    return () => clearInterval(interval);
  }, [fetchAvailability, chaosFlag]);

  const activeCoach = availability?.coaches?.find((c) => c.coachId === selectedCoachId);

  // 3. Recalculate Dynamic Fare & Senior Concession whenever coach or passenger changes (FR 7, 9, 10)
  useEffect(() => {
    if (!activeCoach) return;
    axios.post(`${API_BASE}/fare/calculate`, {
      baseFare: activeCoach.baseFare,
      occupancyPercentage: activeCoach.occupancyPercentage,
      passengerAge: passenger.age || 30,
      passengerGender: passenger.gender,
    }).then((res) => setFareBreakdown(res.data.breakdown))
      .catch(() => {});
  }, [activeCoach, passenger.age, passenger.gender]);

  // 4. Select & Lock Berth with Concurrency Protection (FR 4, 5, 14)
  const handleSelectBerth = async (berth) => {
    if (berth.effectiveStatus === 'BOOKED' || berth.effectiveStatus === 'LOCKED_BY_OTHER') {
      setToastMsg(`Berth ${berth.berthId} is unavailable (${berth.effectiveStatus}).`);
      return;
    }

    try {
      const res = await axios.post(`${API_BASE}/berths/lock`, {
        trainNumber: selectedTrain,
        coachId: activeCoach.coachId,
        berthId: berth.berthId,
        sessionId: SESSION_ID,
      });
      setLockedBerth(res.data.lockedBerth);
      setToastMsg(`Berth ${berth.berthId} (${berth.berthType}) locked for 5 minutes!`);
      fetchAvailability(false);
    } catch (err) {
      setToastMsg(err.response?.data?.message || 'Conflict: Another user just locked this berth.');
      fetchAvailability(false);
    }
  };

  // 5. Confirm Final Booking
  const handleConfirmBooking = async (e) => {
    e.preventDefault();
    if (!lockedBerth) return;

    try {
      const res = await axios.post(`${API_BASE}/bookings/confirm`, {
        trainNumber: lockedBerth.trainNumber,
        coachId: lockedBerth.coachId,
        berthId: lockedBerth.berthId,
        sessionId: SESSION_ID,
        passenger,
      });
      setConfirmedTicket(res.data.ticket);
      setLockedBerth(null);
      fetchAvailability(false);
    } catch (err) {
      setErrorMsg(err.response?.data?.message || 'Booking failed. Please re-select your berth.');
    }
  };

  // 6. Load & Save Admin Pricing Rules
  const loadAdminRules = async () => {
    const res = await axios.get(`${API_BASE}/admin/pricing-rules`);
    setRules(res.data.rules);
  };

  const handleSaveRules = async (e) => {
    e.preventDefault();
    const res = await axios.put(`${API_BASE}/admin/pricing-rules`, rules);
    setRules(res.data.rules);
    setToastMsg('Pricing & Senior Citizen concession rules updated live!');
  };

  const isSeniorAge =
    (passenger.gender === 'M' && passenger.age >= 60) ||
    (passenger.gender === 'F' && passenger.age >= 58);

  return (
    <div>
      {/* TOP NAVIGATION BAR */}
      <nav className="navbar">
        <div>
          <h1>IRCTC Intelligent Seat & Dynamic Pricing System</h1>
          <small style={{ opacity: 0.8 }}>Session ID: {SESSION_ID}</small>
        </div>
        <div className="nav-actions">
          <button
            className={`btn btn-outline ${view === 'booking' ? 'active' : ''}`}
            onClick={() => setView('booking')}
          >
            Passenger Booking
          </button>
          <button
            className={`btn btn-outline ${view === 'admin' ? 'active' : ''}`}
            onClick={() => { setView('admin'); loadAdminRules(); }}
          >
            Admin Pricing Config
          </button>
        </div>
      </nav>

      <div className="container">
        {/* ERROR & RETRY BANNER (FR 17 & FR 18) */}
        {errorMsg && (
          <div className="alert alert-error">
            <span><strong>IRCTC Sync Warning:</strong> {errorMsg}</span>
            <button
              className="btn btn-danger"
              onClick={() => { setChaosFlag(''); fetchAvailability(true); }}
            >
              Clear Simulation & Retry
            </button>
          </div>
        )}

        {/* TOAST NOTIFICATION */}
        {toastMsg && (
          <div className="alert alert-info">
            <span>{toastMsg}</span>
            <button className="btn btn-primary" onClick={() => setToastMsg(null)}>Dismiss</button>
          </div>
        )}

        {/* CONFIRMED TICKET RECEIPT */}
        {confirmedTicket && (
          <div className="alert alert-success">
            <div>
              <strong>Booking Confirmed! PNR: {confirmedTicket.pnr}</strong> —{' '}
              {confirmedTicket.passenger.name} | Coach {confirmedTicket.coachId}, Berth{' '}
              {confirmedTicket.berthId} ({confirmedTicket.berthType}) | Paid ₹{confirmedTicket.finalFarePaid}
            </div>
            <button className="btn btn-primary" onClick={() => setConfirmedTicket(null)}>Close</button>
          </div>
        )}

        {/* ================= VIEW 1: PASSENGER BOOKING ================= */}
        {view === 'booking' && (
          <>
            {/* TRAIN SELECTOR + CHAOS TESTING CONTROLS */}
            <div className="card train-bar">
              <div className="train-tabs">
                {trains.map((t) => (
                  <button
                    key={t.trainNumber}
                    className={`train-chip ${selectedTrain === t.trainNumber ? 'selected' : ''}`}
                    onClick={() => { setSelectedTrain(t.trainNumber); setLockedBerth(null); }}
                  >
                    <strong>{t.trainNumber} — {t.trainName}</strong>
                    <div style={{ fontSize: '0.8rem', color: '#475569' }}>
                      {t.source} → {t.destination} ({t.departureTime})
                    </div>
                  </button>
                ))}
              </div>

              {/* FR 17 & FR 18 Demo Buttons */}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  className="btn btn-warning"
                  onClick={() => setChaosFlag('fail=true')}
                  title="Simulate IRCTC 503 Server Crash"
                >
                  Simulate API Crash
                </button>
                <button
                  className="btn btn-warning"
                  onClick={() => setChaosFlag('delay=5000')}
                  title="Simulate 5s Network Timeout"
                >
                  Simulate Timeout
                </button>
              </div>
            </div>

            <div className="grid-main">
              {/* LEFT COLUMN: INTERACTIVE COACH & BERTH MAP */}
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2>Select Coach & Preferred Berth</h2>
                  {loading && <span style={{ fontSize: '0.85rem', color: '#2563eb' }}>Syncing...</span>}
                </div>

                {/* COACH TABS */}
                <div className="coach-tabs">
                  {availability?.coaches?.map((c) => (
                    <button
                      key={c.coachId}
                      className={`coach-tab ${selectedCoachId === c.coachId ? 'selected' : ''}`}
                      onClick={() => setSelectedCoachId(c.coachId)}
                    >
                      <strong>{c.coachId} ({c.coachClass})</strong>
                      <span className={`badge badge-${c.demandLevel}`}>
                        {c.demandLevel} ({c.surgeMultiplier}x)
                      </span>
                      <div style={{ fontSize: '0.78rem', marginTop: '4px' }}>
                        {c.availableBerths} free • {c.occupancyPercentage}% full
                      </div>
                    </button>
                  ))}
                </div>

                {/* SENIOR CITIZEN LOWER BERTH ALERT (FR 8 & 9) */}
                {seniorAssistActive && isSeniorAge && activeCoach && (
                  <div className="alert alert-info" style={{ marginBottom: '12px' }}>
                    {activeCoach.recommendedLowerBerths.length > 0 ? (
                      <span>
                        <strong>Senior Citizen Assist Active:</strong> Highlighted{' '}
                        <strong>{activeCoach.recommendedLowerBerths.length} Lower Berths</strong> in yellow for easy access.
                      </span>
                    ) : (
                      <span>
                        <strong>No Lower Berths Left in {activeCoach.coachId}:</strong> Please check another coach or select an available Middle/Side berth below.
                      </span>
                    )}
                  </div>
                )}

                {/* COLOR LEGEND */}
                <div className="legend">
                  <div className="legend-item"><span className="dot status-AVAILABLE"></span> Available</div>
                  <div className="legend-item"><span className="dot status-SENIOR_REC"></span> Senior Lower Berth</div>
                  <div className="legend-item"><span className="dot status-LOCKED_BY_YOU"></span> Locked by You</div>
                  <div className="legend-item"><span className="dot status-LOCKED_BY_OTHER"></span> Locked (Other User)</div>
                  <div className="legend-item"><span className="dot status-BOOKED"></span> Booked</div>
                </div>

                {/* BERTH VISUAL GRID */}
                {activeCoach && (
                  <div className="berth-grid">
                    {activeCoach.berths.map((b) => {
                      let statusClass = `status-${b.effectiveStatus}`;
                      if (
                        b.effectiveStatus === 'AVAILABLE' &&
                        seniorAssistActive &&
                        isSeniorAge &&
                        b.isSeniorRecommended
                      ) {
                        statusClass = 'status-SENIOR_REC';
                      }

                      return (
                        <div
                          key={b.berthId}
                          className={`berth-box ${statusClass}`}
                          onClick={() => handleSelectBerth(b)}
                        >
                          <div style={{ fontSize: '1rem' }}>{b.berthNumber} — {b.berthType}</div>
                          <div style={{ fontSize: '0.72rem', marginTop: '4px' }}>
                            {b.effectiveStatus === 'LOCKED_BY_YOU'
                              ? 'SELECTED'
                              : b.effectiveStatus === 'LOCKED_BY_OTHER'
                              ? 'HELD'
                              : b.effectiveStatus}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* RIGHT COLUMN: PASSENGER DETAILS & TRANSPARENT FARE BREAKDOWN */}
              <div className="card">
                <h2 style={{ marginBottom: '14px' }}>Passenger & Fare Details</h2>
                <form onSubmit={handleConfirmBooking}>
                  <div className="form-group">
                    <label>Passenger Full Name</label>
                    <input
                      type="text"
                      required
                      value={passenger.name}
                      onChange={(e) => setPassenger({ ...passenger, name: e.target.value })}
                    />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <div className="form-group">
                      <label>Age</label>
                      <input
                        type="number"
                        min="1"
                        max="120"
                        required
                        value={passenger.age}
                        onChange={(e) => setPassenger({ ...passenger, age: Number(e.target.value) })}
                      />
                    </div>
                    <div className="form-group">
                      <label>Gender</label>
                      <select
                        value={passenger.gender}
                        onChange={(e) => setPassenger({ ...passenger, gender: e.target.value })}
                      >
                        <option value="M">Male</option>
                        <option value="F">Female</option>
                        <option value="O">Other</option>
                      </select>
                    </div>
                  </div>

                  <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      id="seniorToggle"
                      style={{ width: 'auto' }}
                      checked={seniorAssistActive}
                      onChange={(e) => setSeniorAssistActive(e.target.checked)}
                    />
                    <label htmlFor="seniorToggle" style={{ margin: 0 }}>
                      Enable Senior Citizen Lower-Berth Assist
                    </label>
                  </div>

                  <hr style={{ margin: '16px 0', borderColor: '#e2e8f0' }} />

                  {/* FARE BREAKDOWN CARD */}
                  {fareBreakdown && (
                    <div>
                      <h3 style={{ fontSize: '1rem', marginBottom: '8px' }}>Transparent Fare Breakup</h3>
                      <div className="fare-row">
                        <span>Base Railway Fare ({activeCoach?.coachId})</span>
                        <span>₹{fareBreakdown.baseFare}</span>
                      </div>
                      <div className="fare-row">
                        <span>
                          Dynamic Demand Surge ({fareBreakdown.demandLevel} • {fareBreakdown.occupancyPercentage}% full)
                        </span>
                        <span style={{ color: fareBreakdown.demandSurcharge > 0 ? '#b45309' : '#166534' }}>
                          + ₹{fareBreakdown.demandSurcharge} ({fareBreakdown.surgeMultiplier}x)
                        </span>
                      </div>
                      <div className="fare-row">
                        <span>
                          Senior Citizen Concession ({fareBreakdown.isSeniorEligible ? `${fareBreakdown.concessionPercentage}% Applied` : 'Not Eligible'})
                        </span>
                        <span style={{ color: '#166534' }}>
                          - ₹{fareBreakdown.seniorConcession}
                        </span>
                      </div>
                      <div className="fare-total">
                        <span>Total Payable</span>
                        <span>₹{fareBreakdown.totalPayable}</span>
                      </div>
                    </div>
                  )}

                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ width: '100%', marginTop: '18px', padding: '12px' }}
                    disabled={!lockedBerth}
                  >
                    {lockedBerth
                      ? `Confirm & Book Berth ${lockedBerth.berthId}`
                      : 'Select an Available Berth to Lock'}
                  </button>
                </form>
              </div>
            </div>
          </>
        )}

        {/* ================= VIEW 2: SYSTEM ADMIN CONFIGURATION ================= */}
        {view === 'admin' && rules && (
          <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
            <h2 style={{ marginBottom: '16px' }}>Admin Dynamic Pricing & Concession Parameters</h2>
            <form onSubmit={handleSaveRules}>
              <div className="form-group">
                <label>Moderate Demand Occupancy Threshold (%)</label>
                <input
                  type="number"
                  value={rules.low_demand_threshold}
                  onChange={(e) => setRules({ ...rules, low_demand_threshold: Number(e.target.value) })}
                />
              </div>
              <div className="form-group">
                <label>Moderate Demand Multiplier (e.g. 1.15)</label>
                <input
                  type="number"
                  step="0.05"
                  value={rules.medium_demand_multiplier}
                  onChange={(e) => setRules({ ...rules, medium_demand_multiplier: Number(e.target.value) })}
                />
              </div>
              <div className="form-group">
                <label>High Demand Occupancy Threshold (%)</label>
                <input
                  type="number"
                  value={rules.medium_demand_threshold}
                  onChange={(e) => setRules({ ...rules, medium_demand_threshold: Number(e.target.value) })}
                />
              </div>
              <div className="form-group">
                <label>High Demand Multiplier (e.g. 1.35)</label>
                <input
                  type="number"
                  step="0.05"
                  value={rules.high_demand_multiplier}
                  onChange={(e) => setRules({ ...rules, high_demand_multiplier: Number(e.target.value) })}
                />
              </div>
              <div className="form-group">
                <label>Senior Citizen Concession (%)</label>
                <input
                  type="number"
                  value={rules.senior_concession_pct}
                  onChange={(e) => setRules({ ...rules, senior_concession_pct: Number(e.target.value) })}
                />
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%', padding: '12px' }}>
                Save Live Pricing Rules
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}