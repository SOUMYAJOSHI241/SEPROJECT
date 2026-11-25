# IRCTC Intelligent Seat Selection & Dynamic Pricing Engine

![Node.js](https://img.shields.io/badge/Node.js-v18%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-v18-61DAFB?style=flat-square&logo=react&logoColor=black)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v14%2B-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-REST_API-000000?style=flat-square&logo=express&logoColor=white)
![Status](https://img.shields.io/badge/Build-Passing-success?style=flat-square)

An enterprise-grade, decoupled enhancement layer designed to modernize the Indian Railway Catering and Tourism Corporation (IRCTC) ticket booking workflow. The platform provides interactive coach-level seat selection, automated senior citizen lower-berth matching, demand-elastic dynamic pricing, and ACID-compliant concurrency control without modifying core railway infrastructure.

---

## Table of Contents

- [Core Capabilities](#core-capabilities)
- [System Architecture](#system-architecture)
- [Technology Stack](#technology-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Database Configuration](#database-configuration)
  - [Environment Variables](#environment-variables)
  - [Running the Services](#running-the-services)
- [API Specification](#api-specification)
- [Quality Assurance & Verification](#quality-assurance--verification)
- [Production IRCTC Integration Strategy](#production-irctc-integration-strategy)
- [Contributors](#contributors)

---

## Core Capabilities

* **Interactive Coach & Berth Visualization:** Real-time, color-coded berth grid supporting standard Indian Railways coach configurations (`3A`, `2A`, `SL`, `CC`) with berth-type classification (`LB`, `MB`, `UB`, `SL`, `SU`).
* **Senior Citizen Accessibility Engine:** Automatically evaluates passenger eligibility (Male $\ge 60$, Female $\ge 58$), highlights available lower berths for mobility convenience, provides alternative berth guidance upon depletion, and applies configurable concession rates.
* **Demand-Aware Dynamic Pricing:** Calculates transparent, itemized fare breakdowns (`Base Fare + Occupancy Surge - Senior Concession`) driven by live coach occupancy thresholds.
* **ACID Concurrency & Race-Condition Prevention:** Implements PostgreSQL row-level locking (`SELECT ... FOR UPDATE`) with a 5-minute TTL hold mechanism to eliminate double-booking collisions under concurrent load.
* **Resilient Upstream Adapter:** Interfaces with an isolated Mock IRCTC Core Service over REST/JSON with configurable timeout thresholds (`< 3.5s`) and graceful degradation/retry workflows.
* **Role-Based Admin Governance:** Live administrative control panel to tune occupancy surge multipliers and senior citizen concession rules without server restarts.

---

## System Architecture

The application follows a decoupled **3-Tier Adapter Architecture**, isolating core railway inventory management from value-added pricing and seat-selection intelligence.

```text
┌─────────────────────────┐       HTTPS / JSON        ┌─────────────────────────────┐
│     React Frontend      │ ◄───────────────────────► │     Enhancement Backend     │
│    (Vite • Port 5173)   │   4s Real-Time Polling    │   (Node/Express • Port 4000)│
└─────────────────────────┘                           └──────────────┬──────────────┘
                                                                     │
                                       ┌─────────────────────────────┴─────────────────────────────┐
                                       │                                                           │
                                       ▼                                                           ▼
                        ┌─────────────────────────────┐                             ┌─────────────────────────────┐
                        │     PostgreSQL Database     │                             │   Mock IRCTC Core Service   │
                        │    (Port 5432 • ACID Tx)    │                             │  (Node/Express • Port 4001) │
                        ├─────────────────────────────┤                             ├─────────────────────────────┤
                        │ • Row-Level Berth Locks     │                             │ • Raw Train & Coach State   │
                        │ • Audit Booking Ledger      │                             │ • PNR Generation & Commit   │
                        │ • Dynamic Pricing Rules     │                             │ • Chaos / Latency Simulator │
                        └─────────────────────────────┘                             └─────────────────────────────┘
```

---

## Technology Stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Frontend** | React 18, Vite, Axios, CSS3 | Responsive UI, interactive seat map, real-time state synchronization |
| **Enhancement API** | Node.js, Express.js | Concurrency management, dynamic pricing engine, concession logic |
| **Upstream Mock** | Node.js, Express.js | Simulates authorized IRCTC REST endpoints, PNR lifecycle, and fault injection |
| **Database** | PostgreSQL 14+ (`pg`) | Transactional berth locking, configurable rule storage, booking persistence |

---

## Project Structure

```text
SEProject/
├── mock-irctc-service/          # Simulated IRCTC Core API (Port 4001)
│   ├── package.json
│   └── server.js                # Train inventory, berth layouts, PNR commit, chaos middleware
├── enhancement-backend/         # Primary Business Logic & Adapter Layer (Port 4000)
│   ├── .env                     # Database & upstream service configuration
│   ├── package.json
│   └── server.js                # Locking transactions, pricing/concession engine, admin APIs
└── irctc-frontend/              # Client Web Application (Port 5173)
    ├── src/
    │   ├── App.jsx              # Booking workflow, senior assist, admin config, retry handlers
    │   └── App.css              # Responsive grid & status styling
    └── package.json
```

---

## Getting Started

### Prerequisites

* **Node.js** `v18.0.0` or higher
* **npm** `v9.0.0` or higher
* **PostgreSQL** `v14.0` or higher

### Database Configuration

1. Create a PostgreSQL database named `irctc_enhancement`.
2. Execute the initialization schema below via `psql` or pgAdmin:

```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    age INT NOT NULL,
    gender VARCHAR(10) NOT NULL,
    role VARCHAR(20) DEFAULT 'passenger'
);

CREATE TABLE pricing_rules (
    id SERIAL PRIMARY KEY,
    low_demand_threshold INT DEFAULT 50,
    medium_demand_threshold INT DEFAULT 75,
    high_demand_multiplier NUMERIC(4,2) DEFAULT 1.35,
    medium_demand_multiplier NUMERIC(4,2) DEFAULT 1.15,
    senior_male_min_age INT DEFAULT 60,
    senior_female_min_age INT DEFAULT 58,
    senior_concession_pct NUMERIC(5,2) DEFAULT 40.00,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE berth_locks (
    lock_id SERIAL PRIMARY KEY,
    train_number VARCHAR(20) NOT NULL,
    coach_id VARCHAR(20) NOT NULL,
    berth_id VARCHAR(30) NOT NULL,
    user_session_id VARCHAR(100) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    UNIQUE(train_number, coach_id, berth_id)
);

CREATE TABLE bookings (
    id SERIAL PRIMARY KEY,
    pnr VARCHAR(20) UNIQUE NOT NULL,
    train_number VARCHAR(20) NOT NULL,
    coach_id VARCHAR(20) NOT NULL,
    berth_id VARCHAR(30) NOT NULL,
    passenger_name VARCHAR(100) NOT NULL,
    passenger_age INT NOT NULL,
    passenger_gender VARCHAR(10) NOT NULL,
    base_fare NUMERIC(10,2) NOT NULL,
    surge_amount NUMERIC(10,2) NOT NULL,
    concession_amount NUMERIC(10,2) NOT NULL,
    final_fare NUMERIC(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'CONFIRMED',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO pricing_rules (id) VALUES (1);
INSERT INTO users (name, email, password_hash, age, gender, role)
VALUES ('System Admin', 'admin@irctc-enhance.in', 'admin123', 35, 'M', 'admin');
```

### Environment Variables

Create a `.env` file in `enhancement-backend/`:

| Variable | Description | Default Value |
| :--- | :--- | :--- |
| `PORT` | Port for the Enhancement Backend server | `4000` |
| `MOCK_IRCTC_URL` | Base URL of the upstream IRCTC Core API | `http://localhost:4001/irctc/v1` |
| `DATABASE_URL` | PostgreSQL connection URI | `postgresql://postgres:root@localhost:5432/irctc_enhancement` |

### Running the Services

Launch each service in a dedicated terminal instance:

```bash
# 1. Start Mock IRCTC Core Service (Port 4001)
cd mock-irctc-service && npm install && node server.js

# 2. Start Enhancement Backend (Port 4000)
cd enhancement-backend && npm install && node server.js

# 3. Start React Frontend (Port 5173)
cd irctc-frontend && npm install && npm run dev
```

Access the application at **`http://localhost:5173`**.

---

## API Specification

### Enhancement Backend (`http://localhost:4000/api`)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/trains` | Retrieves available trains from the upstream IRCTC adapter. |
| `GET` | `/trains/:trainNumber/availability` | Returns enriched coach layouts, active seat locks, surge multipliers, and lower-berth flags. |
| `POST` | `/berths/lock` | Acquires a 5-minute row-level lock (`SELECT FOR UPDATE`) on a selected berth. |
| `POST` | `/fare/calculate` | Computes itemized dynamic pricing and senior citizen concession breakdowns. |
| `POST` | `/bookings/confirm` | Validates active lock, commits PNR to upstream IRCTC API, and logs transaction. |
| `GET` | `/admin/pricing-rules` | Fetches active occupancy surge thresholds and concession rules. |
| `PUT` | `/admin/pricing-rules` | Updates pricing multipliers and concession parameters in real time. |

### Mock IRCTC Core Service (`http://localhost:4001/irctc/v1`)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/trains/:trainNumber/availability` | Returns raw coach occupancy and berth status (`AVAILABLE` / `BOOKED`). Supports `?fail=true` and `?delay=ms`. |
| `POST` | `/bookings/commit` | Permanently marks a berth `BOOKED` and issues a 10-digit PNR. |
| `POST` | `/bookings/:pnr/cancel` | Cancels an existing PNR and releases the associated berth. |
| `POST` | `/admin/reset` | Resets in-memory train inventory and PNR state to initial seed values. |

---

## Quality Assurance & Verification

| Feature Area | Verification Procedure | Expected Outcome |
| :--- | :--- | :--- |
| **Dynamic Pricing** | Toggle between Coach `B1` (~50% occupancy) and Coach `B2` (~83% occupancy) on Train `12951`. | Surge multiplier scales from `1.15x` (`MODERATE`) to `1.35x` (`HIGH`) with real-time fare recalculation. |
| **Senior Citizen Assist** | Toggle passenger age between `64` (eligible) and `30` (ineligible). | Eligible seniors see lower berths highlighted and a `40%` concession deducted automatically. |
| **Concurrency Control** | Open two browser sessions (`Tab A` and `Tab B`) and select the same berth. | `Tab A` acquires a blue lock; `Tab B` updates to `HELD` within 4 seconds and rejects duplicate lock requests (`HTTP 409`). |
| **Fault Tolerance** | Trigger **Simulate API Crash** (`503`) or **Simulate Timeout** (`>3.5s`). | Application surfaces an actionable retry banner without UI crash and recovers upon retry. |

---

## Production IRCTC Integration Strategy

To transition from the sandboxed Mock IRCTC layer to production Indian Railways infrastructure:

1. **Authorization:** Onboard as an IRCTC B2C Principal Service Provider (PSP) or integrate via an authorized B2B aggregator API with CERT-In security audit compliance.
2. **Configuration Swap:** Update `MOCK_IRCTC_URL` in `.env` to the authorized production endpoint and inject API keys / IP-whitelisted headers into `irctcClient`.
3. **Payload Normalization:** Map external IRCTC quota (`GN`, `SS`) and berth status codes within the backend adapter layer—requiring zero modifications to the frontend or database schema.

---

## Contributors

* **Shubhansh Sharma** (`EN24CS3010993`) — System Architecture, Database Design & Integration
* **Sparsh Choudhary** (`EN24CS3011017`) — Backend APIs & Dynamic Pricing Engine
* **Soumya Joshi** (`EN24CS3011012`) — Frontend UI, Seat Map & Quality Assurance
* **Juned Baig** (`EN24IT3010048`) — Requirements Engineering & System Validation
