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
  const [startLabel, setStartLabel] = useState<string>("");
  const [endLabel, setEndLabel] = useState<string>("");

  const loadFiles = async () => {
    const response = await fetch(`${API_BASE}/api/input-files`);
    const payload = (await response.json()) as InputFilesResponse;
    setInputFiles(payload.files);
    setSeriesNames(payload.series_names);
    setSelectedSeries((prev) =>
      prev && payload.series_names.includes(prev) ? prev : payload.series_names[0] || ""
    );
    setSelectedFiles((prev) =>
      prev.length ? prev : payload.files.slice(0, 2).map((file) => file.id)
    );
  };

  useEffect(() => {
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

  const availableLabels = useMemo(() => {
    if (selectedFiles.length === 0) return [];
    const primary = inputFiles.find((file) => file.id === selectedFiles[0]);
    return primary?.columns ?? [];
  }, [inputFiles, selectedFiles]);

  useEffect(() => {
    if (availableLabels.length === 0) {
      setStartLabel("");
      setEndLabel("");
      return;
    }
    setStartLabel((prev) => (availableLabels.includes(prev) ? prev : availableLabels[0]));
    setEndLabel((prev) =>
      availableLabels.includes(prev) ? prev : availableLabels[availableLabels.length - 1]
    );
  }, [availableLabels]);

  const handleFileToggle = (fileId: string) => {
    setStatusMessage("");
    setSelectedFiles((prev) => {
      if (prev.includes(fileId)) {
        return prev.filter((item) => item !== fileId);
      }
      return [...prev, fileId];
    });
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch(`${API_BASE}/api/input-files/upload`, {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      const error = await response.json();
      setStatusMessage(error.detail ?? "Unable to upload file.");
      return;
    }
    await loadFiles();
    setStatusMessage(`Uploaded ${file.name}.`);
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
        files: selectedFiles,
        start_label: startLabel || null,
        end_label: endLabel || null
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

  const updateValue = async (fileId: string, label: string, value: number) => {
    const response = await fetch(`${API_BASE}/api/input-files/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_id: fileId,
        series_name: selectedSeries,
        label,
        value
      })
    });
    if (!response.ok) {
      const error = await response.json();
      setStatusMessage(error.detail ?? "Unable to update value.");
    }
  };

  const handlePlotUpdate = (figure: { data?: { y?: Array<number | null> }[] }) => {
    if (!plotResponse || !figure.data) return;
    const updates: PlotResponse = {
      labels: plotResponse.labels,
      series: plotResponse.series.map((entry) => ({ ...entry }))
    };
    let hasChanges = false;
    figure.data.forEach((trace, traceIdx) => {
      const updatedValues = trace?.y ?? [];
      const current = plotResponse.series[traceIdx]?.values ?? [];
      updatedValues.forEach((value, idx) => {
        if (value === undefined || current[idx] === value) return;
        const numericValue = value === null ? null : Number(value);
        if (numericValue === null || Number.isNaN(numericValue)) return;
        updates.series[traceIdx].values[idx] = numericValue;
        hasChanges = true;
        void updateValue(plotResponse.series[traceIdx].file, plotResponse.labels[idx], numericValue);
      });
    });
    if (hasChanges) {
      setPlotResponse(updates);
    }
  };

  return (
    <main>
      <h1>Impulse Overlay – Financial Time Series</h1>

      <section className="card">
        <div className="section-title">1) Upload & available files</div>
        <input type="file" accept=".csv,.xlsx" onChange={handleUpload} />
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
          Choose files to plot simultaneously. Each row in the CSV is treated as a time-series
          entry with the first column as the name.
        </p>
      </section>

      <section className="card">
        <div className="section-title">2) Plot selection & time range</div>
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
            <label>Start label</label>
            <select
              value={startLabel}
              onChange={(event) => setStartLabel(event.target.value)}
            >
              {availableLabels.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>End label</label>
            <select value={endLabel} onChange={(event) => setEndLabel(event.target.value)}>
              {availableLabels.map((label) => (
                <option key={label} value={label}>
                  {label}
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
                hovermode: "closest",
                dragmode: "closest"
              }}
              config={{ editable: true }}
              onUpdate={handlePlotUpdate}
            />
            <p className="notice">Drag points on the chart or edit values in the table below.</p>
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
                      <td key={`${seriesEntry.file}-${idx}`}>
                        <input
                          type="number"
                          value={value ?? ""}
                          onChange={(event) => {
                            const nextValue = event.target.value === "" ? null : Number(event.target.value);
                            if (nextValue !== null && Number.isNaN(nextValue)) return;
                            setPlotResponse((prev) => {
                              if (!prev) return prev;
                              const updated = {
                                labels: prev.labels,
                                series: prev.series.map((entry) => ({ ...entry }))
                              };
                              const target = updated.series.find((entry) => entry.file === seriesEntry.file);
                              if (!target) return prev;
                              target.values[idx] = nextValue;
                              return updated;
                            });
                          }}
                          onBlur={(event) => {
                            const nextValue = Number(event.target.value);
                            if (Number.isNaN(nextValue)) return;
                            void updateValue(seriesEntry.file, plotResponse.labels[idx], nextValue);
                            setPlotResponse((prev) => {
                              if (!prev) return prev;
                              const updated = {
                                labels: prev.labels,
                                series: prev.series.map((entry) => ({ ...entry }))
                              };
                              const target = updated.series.find((entry) => entry.file === seriesEntry.file);
                              if (!target) return prev;
                              target.values[idx] = nextValue;
                              return updated;
                            });
                          }}
                        />
                      </td>
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
