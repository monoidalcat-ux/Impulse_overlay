import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: () => <p className="notice">Loading chart…</p>
});

type InputFile = {
  id: string;
  name: string;
  series: string[];
  columns: string[];
};

type InputFilesResponse = {
  files: InputFile[];
  series_names: string[];
};

type PlotResponse = {
  labels: string[];
  series: {
    file: string;
    values: (number | null)[];
  }[];
};

const API_BASE = "http://localhost:8000";

export default function Home() {
  const [inputFiles, setInputFiles] = useState<InputFile[]>([]);
  const [seriesNames, setSeriesNames] = useState<string[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<string>("");
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [plotResponse, setPlotResponse] = useState<PlotResponse | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");

  useEffect(() => {
    const loadFiles = async () => {
      const response = await fetch(`${API_BASE}/api/input-files`);
      const payload = (await response.json()) as InputFilesResponse;
      setInputFiles(payload.files);
      setSeriesNames(payload.series_names);
      setSelectedSeries(payload.series_names[0] ?? "");
      setSelectedFiles(payload.files.slice(0, 2).map((file) => file.id));
    };
    loadFiles();
  }, []);

  const plotData = useMemo(() => {
    if (!plotResponse) return [];
    return plotResponse.series.map((seriesEntry) => ({
      x: plotResponse.labels,
      y: seriesEntry.values,
      type: "scatter",
      mode: "lines+markers",
      name: seriesEntry.file
    }));
  }, [plotResponse]);

  const handleFileToggle = (fileId: string) => {
    setStatusMessage("");
    setSelectedFiles((prev) => {
      if (prev.includes(fileId)) {
        return prev.filter((item) => item !== fileId);
      }
      if (prev.length >= 2) {
        setStatusMessage("Select up to two files to compare at once.");
        return prev;
      }
      return [...prev, fileId];
    });
  };

  const fetchPlot = async () => {
    if (!selectedSeries || selectedFiles.length === 0) {
      setStatusMessage("Choose a series name and at least one file.");
      return;
    }
    const response = await fetch(`${API_BASE}/api/plot-series`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        series_name: selectedSeries,
        files: selectedFiles
      })
    });
    if (!response.ok) {
      const error = await response.json();
      setStatusMessage(error.detail ?? "Unable to load series data.");
      return;
    }
    const payload = (await response.json()) as PlotResponse;
    setPlotResponse(payload);
  };

  return (
    <main>
      <h1>Impulse Overlay – Financial Time Series</h1>

      <section className="card">
        <div className="section-title">1) Available input files</div>
        {inputFiles.length === 0 && (
          <p className="notice">No input files found. Add CSVs to the test folder.</p>
        )}
        {inputFiles.length > 0 && (
          <div className="grid">
            {inputFiles.map((file) => (
              <label key={file.id}>
                <input
                  type="checkbox"
                  checked={selectedFiles.includes(file.id)}
                  onChange={() => handleFileToggle(file.id)}
                />
                {" "}{file.name} ({file.series.length} series)
              </label>
            ))}
          </div>
        )}
        <p className="notice">
          Choose up to two files to plot simultaneously. Each row in the CSV is treated as a
          time-series entry with the first column as the name.
        </p>
      </section>

      <section className="card">
        <div className="section-title">2) Plot selection</div>
        <div className="grid">
          <div>
            <label>Series name</label>
            <select
              value={selectedSeries}
              onChange={(event) => setSelectedSeries(event.target.value)}
            >
              {seriesNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>&nbsp;</label>
            <button onClick={fetchPlot} type="button">
              Load plot
            </button>
          </div>
        </div>
        {statusMessage && <p className="notice">{statusMessage}</p>}
        {plotResponse && (
          <>
            <Plot
              data={plotData}
              layout={{
                title: `Series: ${selectedSeries}`,
                height: 520,
                margin: { t: 50, r: 30, l: 50, b: 40 },
                hovermode: "closest"
              }}
            />
            <h4>Series values by file</h4>
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  {plotResponse.labels.map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plotResponse.series.map((seriesEntry) => (
                  <tr key={seriesEntry.file}>
                    <td>{seriesEntry.file}</td>
                    {seriesEntry.values.map((value, idx) => (
                      <td key={`${seriesEntry.file}-${idx}`}>{value ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </main>
  );
}
