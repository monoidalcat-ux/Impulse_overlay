import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import type { PlotMouseEvent } from "plotly.js";

const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: () => <p className="notice">Loading chart…</p>
});

type UploadResponse = {
  dataset_id: string;
  columns: string[];
  numeric_columns: string[];
  date_column: string;
  preview: Record<string, string | number | null>[];
  min_date: string | null;
  max_date: string | null;
};

type SeriesResponse = {
  data: {
    dates: string[];
    [key: string]: (string | number)[];
  };
  table: Record<string, string | number | null>[];
};

type EditPoint = {
  date: string;
  column: string;
  value: number;
};

const API_BASE = "http://localhost:8000";

export default function Home() {
  const [dataset, setDataset] = useState<UploadResponse | null>(null);
  const [selectedDateColumn, setSelectedDateColumn] = useState<string>("");
  const [selectedSeries, setSelectedSeries] = useState<string[]>([]);
  const [transform, setTransform] = useState("raw");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [seriesData, setSeriesData] = useState<SeriesResponse | null>(null);
  const [modalEdit, setModalEdit] = useState<EditPoint | null>(null);
  const [editValue, setEditValue] = useState<string>("");

  useEffect(() => {
    if (dataset) {
      setSelectedDateColumn(dataset.date_column);
      setSelectedSeries(dataset.numeric_columns.slice(0, 2));
      setStartDate(dataset.min_date ?? "");
      setEndDate(dataset.max_date ?? "");
    }
  }, [dataset]);

  const plotData = useMemo(() => {
    if (!seriesData) return [];
    return selectedSeries.map((name) => ({
      x: seriesData.data.dates,
      y: seriesData.data[name] ?? [],
      type: "scatter",
      mode: "lines+markers",
      name
    }));
  }, [seriesData, selectedSeries]);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch(`${API_BASE}/api/upload`, {
      method: "POST",
      body: formData
    });
    const payload = (await response.json()) as UploadResponse;
    setDataset(payload);
    setSeriesData(null);
  };

  const fetchSeries = async () => {
    if (!dataset || selectedSeries.length === 0) return;
    const response = await fetch(`${API_BASE}/api/datasets/${dataset.dataset_id}/series`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        date_column: selectedDateColumn,
        series: selectedSeries,
        transform,
        start_date: startDate || null,
        end_date: endDate || null
      })
    });
    const payload = (await response.json()) as SeriesResponse;
    setSeriesData(payload);
  };

  const handleSeriesToggle = (value: string) => {
    setSelectedSeries((prev) =>
      prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]
    );
  };

  const applyQuickRange = (months: number | "ytd" | "all") => {
    if (!dataset?.max_date || !dataset?.min_date) return;
    if (months === "all") {
      setStartDate(dataset.min_date);
      setEndDate(dataset.max_date);
      return;
    }
    const max = new Date(dataset.max_date);
    let start: Date;
    if (months === "ytd") {
      start = new Date(max.getFullYear(), 0, 1);
    } else {
      start = new Date(max);
      start.setMonth(start.getMonth() - months);
    }
    setStartDate(start.toISOString().slice(0, 10));
    setEndDate(dataset.max_date);
  };

  const handlePlotClick = (event: PlotMouseEvent) => {
    const point = event.points?.[0];
    if (!point) return;
    const column = point.data.name as string;
    const date = point.x as string;
    const value = point.y as number;
    setModalEdit({ date, column, value });
    setEditValue(String(value));
  };

  const saveEdit = async () => {
    if (!dataset || !modalEdit) return;
    const value = Number(editValue);
    if (Number.isNaN(value)) return;
    await fetch(`${API_BASE}/api/datasets/${dataset.dataset_id}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        edits: [
          {
            date: modalEdit.date,
            column: modalEdit.column,
            value
          }
        ]
      })
    });
    setModalEdit(null);
    await fetchSeries();
  };

  const updateTableValue = async (date: string, column: string, value: string) => {
    if (!dataset) return;
    const parsed = Number(value);
    if (Number.isNaN(parsed)) return;
    await fetch(`${API_BASE}/api/datasets/${dataset.dataset_id}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits: [{ date, column, value: parsed }] })
    });
    await fetchSeries();
  };

  const exportDataset = (format: "csv" | "xlsx") => {
    if (!dataset) return;
    window.open(`${API_BASE}/api/datasets/${dataset.dataset_id}/export?format=${format}`, "_blank");
  };

  return (
    <main>
      <h1>Impulse Overlay – Financial Time Series</h1>

      <section className="card">
        <div className="section-title">1) Upload interface</div>
        <input type="file" accept=".csv,.xlsx" onChange={handleUpload} />
        {dataset && (
          <div>
            <p className="notice">Detected date column: {dataset.date_column}</p>
            <div className="grid">
              <div>
                <strong>Columns</strong>
                <ul>
                  {dataset.columns.map((col) => (
                    <li key={col}>{col}</li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>Numeric series</strong>
                <ul>
                  {dataset.numeric_columns.map((col) => (
                    <li key={col}>{col}</li>
                  ))}
                </ul>
              </div>
            </div>
            <h4>Preview</h4>
            <table className="table">
              <thead>
                <tr>
                  {dataset.columns.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataset.preview.map((row, idx) => (
                  <tr key={idx}>
                    {dataset.columns.map((col) => (
                      <td key={col}>{row[col] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-title">2) Plot interface</div>
        {!dataset && <p className="notice">Upload a dataset to start plotting.</p>}
        {dataset && (
          <>
            <div className="grid">
              <div>
                <label>Date column</label>
                <select
                  value={selectedDateColumn}
                  onChange={(event) => setSelectedDateColumn(event.target.value)}
                >
                  {dataset.columns.map((col) => (
                    <option key={col} value={col}>
                      {col}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Transform</label>
                <select value={transform} onChange={(event) => setTransform(event.target.value)}>
                  <option value="raw">Raw level</option>
                  <option value="monthly_change">Monthly change</option>
                  <option value="quarterly_change">Quarterly change</option>
                </select>
              </div>
              <div>
                <label>Start date</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                />
              </div>
              <div>
                <label>End date</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </div>
            </div>
            <div style={{ marginTop: "12px" }}>
              <label>Series</label>
              <div className="grid">
                {dataset.numeric_columns.map((col) => (
                  <label key={col}>
                    <input
                      type="checkbox"
                      checked={selectedSeries.includes(col)}
                      onChange={() => handleSeriesToggle(col)}
                    />
                    {" "}{col}
                  </label>
                ))}
              </div>
            </div>
            <div style={{ marginTop: "12px" }} className="quick-range">
              <button className="secondary" onClick={() => applyQuickRange(1)} type="button">
                1M
              </button>
              <button className="secondary" onClick={() => applyQuickRange(3)} type="button">
                3M
              </button>
              <button className="secondary" onClick={() => applyQuickRange(6)} type="button">
                6M
              </button>
              <button className="secondary" onClick={() => applyQuickRange("ytd")} type="button">
                YTD
              </button>
              <button className="secondary" onClick={() => applyQuickRange(12)} type="button">
                1Y
              </button>
              <button className="secondary" onClick={() => applyQuickRange("all")} type="button">
                All
              </button>
              <button onClick={fetchSeries} type="button">
                Load plot
              </button>
            </div>
            {seriesData && (
              <>
                <Plot
                  data={plotData}
                  layout={{
                    title: "Time series",
                    height: 520,
                    margin: { t: 50, r: 30, l: 50, b: 40 },
                    hovermode: "closest"
                  }}
                  onClick={handlePlotClick}
                />
                <div className="inline-actions">
                  <button className="ghost" onClick={() => exportDataset("csv")}>
                    Export CSV
                  </button>
                  <button className="ghost" onClick={() => exportDataset("xlsx")}>
                    Export XLSX
                  </button>
                </div>
                <h4>Editable data grid (selected series)</h4>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      {selectedSeries.map((col) => (
                        <th key={col}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {seriesData.table.map((row, idx) => (
                      <tr key={idx}>
                        <td>{row[selectedDateColumn] ?? ""}</td>
                        {selectedSeries.map((col) => (
                          <td key={col}>
                            <input
                              type="number"
                              defaultValue={row[col] ?? ""}
                              onBlur={(event) =>
                                updateTableValue(
                                  String(row[selectedDateColumn]),
                                  col,
                                  event.target.value
                                )
                              }
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </section>

      {modalEdit && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Edit point</h3>
            <p>
              {modalEdit.column} on {modalEdit.date}
            </p>
            <input
              type="number"
              value={editValue}
              onChange={(event) => setEditValue(event.target.value)}
            />
            <div className="inline-actions" style={{ marginTop: "12px" }}>
              <button onClick={saveEdit}>Save</button>
              <button className="secondary" onClick={() => setModalEdit(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
