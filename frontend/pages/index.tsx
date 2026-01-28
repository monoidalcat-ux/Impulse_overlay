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
  metadata: Record<string, string>;
};

type QuarterLabel = {
  label: string;
  year: string;
  quarter: string;
};

type DisplayMode = "raw" | "quarterly_change" | "year_over_year" | "since_start";

const API_BASE = "http://localhost:8000";

const MODE_OPTIONS: Array<{ value: DisplayMode; label: string; description: string }> = [
  { value: "raw", label: "Original (raw)", description: "Plot the stored values as-is." },
  {
    value: "quarterly_change",
    label: "Quarterly change",
    description: "Change vs. the previous quarter."
  },
  {
    value: "year_over_year",
    label: "Year-over-year change",
    description: "Change vs. the same quarter in the prior year."
  },
  {
    value: "since_start",
    label: "Change vs. first quarter",
    description: "Change vs. the first selected quarter."
  }
];

const isNumericValue = (value: number | null | undefined): value is number =>
  typeof value === "number" && !Number.isNaN(value);

const deriveSeriesValues = (values: (number | null)[], mode: DisplayMode) => {
  if (mode === "raw") {
    return [...values];
  }
  return values.map((value, index, array) => {
    if (!isNumericValue(value)) return null;
    if (mode === "quarterly_change") {
      if (index === 0 || !isNumericValue(array[index - 1])) return null;
      return value - array[index - 1]!;
    }
    if (mode === "year_over_year") {
      if (index < 4 || !isNumericValue(array[index - 4])) return null;
      return value - array[index - 4]!;
    }
    const baseline = array[0];
    if (!isNumericValue(baseline)) return null;
    return value - baseline;
  });
};

export default function Home() {
  const [inputFiles, setInputFiles] = useState<InputFile[]>([]);
  const [seriesNames, setSeriesNames] = useState<string[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<string>("");
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [plotResponse, setPlotResponse] = useState<PlotResponse | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("raw");
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

  const compareLabels = (left: string, right: string) => {
    const leftQuarter = formatQuarterLabel(left);
    const rightQuarter = formatQuarterLabel(right);
    if (leftQuarter.quarter && rightQuarter.quarter) {
      const leftYear = Number(leftQuarter.year);
      const rightYear = Number(rightQuarter.year);
      if (!Number.isNaN(leftYear) && !Number.isNaN(rightYear) && leftYear !== rightYear) {
        return leftYear - rightYear;
      }
      const leftQuarterNumber = Number(leftQuarter.quarter);
      const rightQuarterNumber = Number(rightQuarter.quarter);
      if (!Number.isNaN(leftQuarterNumber) && !Number.isNaN(rightQuarterNumber)) {
        return leftQuarterNumber - rightQuarterNumber;
      }
    }
    const leftDate = Date.parse(left);
    const rightDate = Date.parse(right);
    if (!Number.isNaN(leftDate) && !Number.isNaN(rightDate) && leftDate !== rightDate) {
      return leftDate - rightDate;
    }
    return left.localeCompare(right);
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

  const displayResponse = useMemo(() => {
    if (!plotResponse) return null;
    return {
      ...plotResponse,
      series: plotResponse.series.map((entry) => ({
        ...entry,
        values: deriveSeriesValues(entry.values, displayMode)
      }))
    };
  }, [plotResponse, displayMode]);

  const plotData = useMemo(() => {
    if (!displayResponse) return [];
    return displayResponse.series.map((seriesEntry) => {
      const alignedValues = displayResponse.labels.map(
        (_, index) => seriesEntry.values[index] ?? null
      );
      return {
        x: displayResponse.labels.map((_, index) => index),
        y: alignedValues,
        type: "scatter",
        mode: "lines+markers",
        name: seriesEntry.file,
        marker: { size: 8 },
        connectgaps: false
      };
    });
  }, [displayResponse]);

  const metadataEntries = useMemo(() => {
    if (!plotResponse) return [];
    return Object.entries(plotResponse.metadata ?? {}).filter(([, value]) => value.trim() !== "");
  }, [plotResponse]);

  const availableLabels = useMemo(() => {
    if (selectedFiles.length === 0) return [];
    const merged = new Set<string>();
    selectedFiles.forEach((fileId) => {
      const file = inputFiles.find((entry) => entry.id === fileId);
      file?.columns.forEach((label) => merged.add(label));
    });
    return Array.from(merged).sort(compareLabels);
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

  const handlePointClick = (event: {
    points?: Array<{ curveNumber: number; pointNumber: number; y?: number | null }>;
  }) => {
    if (!plotResponse || !displayResponse || !event.points || event.points.length === 0) return;
    const point = event.points[0];
    const traceIndex = point.curveNumber;
    const pointIndex = point.pointNumber;
    const currentValue =
      point.y ?? displayResponse.series[traceIndex]?.values?.[pointIndex] ?? "";
    const activeMode = MODE_OPTIONS.find((option) => option.value === displayMode);
    const input = window.prompt(
      `Enter a new value for this datapoint (${activeMode?.label ?? "mode"}):`,
      String(currentValue ?? "")
    );
    if (input === null) return;
    const nextValue = Number(input);
    if (Number.isNaN(nextValue)) {
      setStatusMessage("Please enter a valid numeric value.");
      return;
    }
    const rawSeries = plotResponse.series[traceIndex];
    if (!rawSeries) return;
    let nextRawValue: number | null = null;
    if (displayMode === "raw") {
      nextRawValue = nextValue;
    } else if (displayMode === "quarterly_change") {
      const prior = rawSeries.values[pointIndex - 1];
      if (pointIndex === 0 || !isNumericValue(prior)) {
        setStatusMessage("Quarterly change needs a previous quarter value.");
        return;
      }
      nextRawValue = prior + nextValue;
    } else if (displayMode === "year_over_year") {
      const prior = rawSeries.values[pointIndex - 4];
      if (pointIndex < 4 || !isNumericValue(prior)) {
        setStatusMessage("Year-over-year change needs a value from four quarters earlier.");
        return;
      }
      nextRawValue = prior + nextValue;
    } else {
      const baseline = rawSeries.values[0];
      if (!isNumericValue(baseline)) {
        setStatusMessage("Change vs. first quarter needs the first value to be set.");
        return;
      }
      nextRawValue = baseline + nextValue;
    }
    if (!isNumericValue(nextRawValue)) {
      setStatusMessage("Unable to calculate a new value for this mode.");
      return;
    }
    setPlotResponse((prev) => {
      if (!prev) return prev;
      const updated = {
        labels: prev.labels,
        series: prev.series.map((entry) => ({ ...entry }))
      };
      const target = updated.series[traceIndex];
      if (!target) return prev;
      target.values[pointIndex] = nextRawValue;
      return updated;
    });
    void updateValue(plotResponse.series[traceIndex].file, plotResponse.labels[pointIndex], nextRawValue);
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
          entry with the Mnemonic column as the name.
        </p>
      </section>

      <section className="card">
        <div className="section-title">2) Plot selection & time range</div>
        <div className="grid">
          <div>
            <label>Display mode</label>
            <select
              value={displayMode}
              onChange={(event) => setDisplayMode(event.target.value as DisplayMode)}
            >
              {MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="notice">
              {MODE_OPTIONS.find((option) => option.value === displayMode)?.description}
            </p>
          </div>
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
              Plot
            </button>
          </div>
        </div>
        {statusMessage && <p className="notice">{statusMessage}</p>}
        {plotResponse && (
          <>
            <div className="plot-area">
              <div className="plot-panel">
                <Plot
                  data={plotData}
                  layout={{
                    title: `Series: ${selectedSeries} (${MODE_OPTIONS.find((option) => option.value === displayMode)?.label ?? "Mode"})`,
                    height: 520,
                    margin: { t: 50, r: 30, l: 50, b: 80 },
                    hovermode: "closest",
                    dragmode: false,
                    xaxis: {
                      tickmode: "array",
                      tickvals: tickValues,
                      ticktext: tickText,
                      tickangle: -45,
                      automargin: true,
                      fixedrange: true
                    },
                    yaxis: {
                      fixedrange: true
                    }
                  }}
                  config={{
                    scrollZoom: false,
                    doubleClick: false,
                    modeBarButtonsToRemove: [
                      "zoom2d",
                      "pan2d",
                      "select2d",
                      "lasso2d",
                      "zoomIn2d",
                      "zoomOut2d",
                      "autoScale2d",
                      "resetScale2d"
                    ]
                  }}
                  onClick={handlePointClick}
                />
              </div>
              <aside className="metadata-card">
                <h4>Series metadata</h4>
                {metadataEntries.length === 0 ? (
                  <p className="notice">No metadata found for this series.</p>
                ) : (
                  <ul className="metadata-list">
                    {metadataEntries.map(([key, value]) => (
                      <li key={key}>
                        <span>{key}</span>
                        <strong>{value}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </aside>
            </div>
            {yearsOnAxis.length > 0 && (
              <p className="notice">Quarter spacing applied. Years shown: {yearsOnAxis.join(", ")}.</p>
            )}
            <p className="notice">Tip: click a legend item to isolate a track.</p>
          </>
        )}
      </section>
    </main>
  );
}
