# Impulse Overlay MVP

This repository contains a minimal full-stack MVP for uploading financial time series data and interacting with Plotly charts.

## Tech stack
- Frontend: Next.js (TypeScript)
- Backend: FastAPI (Python)
- Charting: Plotly.js

## Features
- Upload CSV/XLSX datasets.
- Infer date column and preview data.
- Select one or more series, time ranges, and transformations.
- Edit points via chart click modal or an inline data grid.
- Export updated dataset to CSV/XLSX.

## Run locally

### Backend (FastAPI)
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Frontend (Next.js)
```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000 in your browser.

## Notes
- Data is stored in memory keyed by `dataset_id` for this MVP.
- The backend expects the frontend to call `http://localhost:8000`.
