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

type QuarterLabel = {
  label: string;
  year: string;
  quarter: string;
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

  const formatQuarterLabel = (label: string): QuarterLabel => {
    const normalized = label.trim();
    const match = normalized.match(/^(\d{4})[-\s]?Q([1-4])$/i);
    if (match) {
      return { label: `Q${match[2]} ${match[1]}`, year: match[1], quarter: match[2] };
    }
    return { label: normalized, year: normalized, quarter: "" };
  };

  const quarterLabels = useMemo(
    () => plotResponse?.labels.map(formatQuarterLabel) ?? [],
    [plotResponse]
  );

  const tickValues = useMemo(
    () => plotResponse?.labels.map((_, index) => index) ?? [],
    [plotResponse]
  );

  const tickText = useMemo(() => quarterLabels.map((entry) => entry.label), [quarterLabels]);
  const yearsOnAxis = useMemo(
    () =>
      quarterLabels
        .filter((entry, index, array) => entry.year && (index === 0 || entry.year !== array[index - 1].year))
        .map((entry) => entry.year),
    [quarterLabels]
  );

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
      x: plotResponse.labels.map((_, index) => index),
      y: seriesEntry.values,
      type: "scatter",
      mode: "lines+markers",
      name: seriesEntry.file,
      marker: { size: 8 }
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

  useEffect(() => {
    if (!plotResponse || !selectedSeries || selectedFiles.length === 0) return;
    void fetchPlot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSeries, selectedFiles, startLabel, endLabel]);

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
      return;
    }
    if (plotResponse) {
      await fetchPlot();
    }
  };

  const deleteInputFile = async (fileId: string) => {
    const response = await fetch(`${API_BASE}/api/input-files/${fileId}`, {
      method: "DELETE"
    });
    if (!response.ok) {
      const error = await response.json();
      setStatusMessage(error.detail ?? "Unable to delete file.");
      return;
    }
    await loadFiles();
    setSelectedFiles((prev) => prev.filter((item) => item !== fileId));
    setPlotResponse((prev) => {
      if (!prev) return prev;
      const updatedSeries = prev.series.filter((entry) => entry.file !== fileId);
      return updatedSeries.length
        ? { labels: prev.labels, series: updatedSeries }
        : null;
    });
    setStatusMessage(`Removed ${fileId}.`);
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
          <div className="grid file-grid">
            {inputFiles.map((file) => (
              <div className="file-row" key={file.id}>
                <div className="file-label">
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedFiles.includes(file.id)}
                      onChange={() => handleFileToggle(file.id)}
                    />
                    {" "}{file.name} ({file.series.length} series)
                  </label>
                  <div className="file-actions">
                    <a
                      className="ghost-button action-download"
                      href={`${API_BASE}/api/input-files/${file.id}/download`}
                      download
                    >
                      Download
                    </a>
                    <button
                      className="ghost-button action-delete"
                      type="button"
                      onClick={() => void deleteInputFile(file.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
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
            <input
              className="search-input"
              list="series-options"
              value={selectedSeries}
              onChange={(event) => setSelectedSeries(event.target.value)}
              onBlur={() => {
                if (!seriesNames.includes(selectedSeries) && seriesNames[0]) {
                  setSelectedSeries(seriesNames[0]);
                }
              }}
            />
            <datalist id="series-options">
              {seriesNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          <div>
            <label>Start label</label>
            <input
              className="search-input"
              list="start-label-options"
              value={startLabel}
              onChange={(event) => setStartLabel(event.target.value)}
              onBlur={() => {
                if (!availableLabels.includes(startLabel) && availableLabels[0]) {
                  setStartLabel(availableLabels[0]);
                }
              }}
            />
            <datalist id="start-label-options">
              {availableLabels.map((label) => (
                <option key={label} value={label} />
              ))}
            </datalist>
          </div>
          <div>
            <label>End label</label>
            <input
              className="search-input"
              list="end-label-options"
              value={endLabel}
              onChange={(event) => setEndLabel(event.target.value)}
              onBlur={() => {
                if (!availableLabels.includes(endLabel) && availableLabels.length) {
                  setEndLabel(availableLabels[availableLabels.length - 1]);
                }
              }}
            />
            <datalist id="end-label-options">
              {availableLabels.map((label) => (
                <option key={label} value={label} />
              ))}
            </datalist>
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
                margin: { t: 50, r: 30, l: 50, b: 80 },
                hovermode: "closest",
                dragmode: "closest",
                xaxis: {
                  tickmode: "array",
                  tickvals: tickValues,
                  ticktext: tickText,
                  tickangle: -45,
                  automargin: true,
                  fixedrange: true
                },
                yaxis: {
                  fixedrange: false
                }
              }}
              config={{
                editable: true,
                edits: { shapePosition: true },
                scrollZoom: false
              }}
              onUpdate={handlePlotUpdate}
            />
            {yearsOnAxis.length > 0 && (
              <p className="notice">Quarter spacing applied. Years shown: {yearsOnAxis.join(", ")}.</p>
            )}
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
