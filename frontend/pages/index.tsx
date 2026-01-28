import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: () => <p className="notice">Loading chart…</p>
});

type InputFile = {
  id: string;
  name: string;
  sheets: string[];
  series_by_sheet: Record<string, string[]>;
  columns_by_sheet: Record<string, string[]>;
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
  period: string;
};

type DisplayMode =
  | "raw"
  | "quarterly_change"
  | "quarterly_change_percent"
  | "year_over_year"
  | "year_over_year_percent"
  | "since_start"
  | "since_start_percent";

const API_BASE = "http://localhost:8000";

const isNumericValue = (value: number | null | undefined): value is number =>
  typeof value === "number" && !Number.isNaN(value);

const deriveSeriesValues = (
  values: (number | null)[],
  mode: DisplayMode,
  periodsPerYear: number
) => {
  if (mode === "raw") {
    return [...values];
  }
  return values.map((value, index, array) => {
    if (!isNumericValue(value)) return null;
    if (mode === "quarterly_change") {
      if (index === 0 || !isNumericValue(array[index - 1])) return null;
      return value - array[index - 1]!;
    }
    if (mode === "quarterly_change_percent") {
      if (index === 0 || !isNumericValue(array[index - 1]) || array[index - 1] === 0) return null;
      return ((value - array[index - 1]!) / array[index - 1]!) * 100;
    }
    if (mode === "year_over_year") {
      if (index < periodsPerYear || !isNumericValue(array[index - periodsPerYear])) return null;
      return value - array[index - periodsPerYear]!;
    }
    if (mode === "year_over_year_percent") {
      if (
        index < periodsPerYear ||
        !isNumericValue(array[index - periodsPerYear]) ||
        array[index - periodsPerYear] === 0
      ) {
        return null;
      }
      return (
        ((value - array[index - periodsPerYear]!) / array[index - periodsPerYear]!) * 100
      );
    }
    if (mode === "since_start") {
      const baseline = array[0];
      if (!isNumericValue(baseline)) return null;
      return value - baseline;
    }
    const baseline = array[0];
    if (!isNumericValue(baseline) || baseline === 0) return null;
    return ((value - baseline) / baseline) * 100;
  });
};

export default function Home() {
  const [inputFiles, setInputFiles] = useState<InputFile[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<string>("");
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [plotResponse, setPlotResponse] = useState<PlotResponse | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("raw");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [startLabel, setStartLabel] = useState<string>("");
  const [endLabel, setEndLabel] = useState<string>("");
  const [selectedSheet, setSelectedSheet] = useState<string>("Quarterly");

  const formatQuarterLabel = (label: string, sheetName: string): QuarterLabel => {
    const normalized = label.trim();
    if (sheetName === "Monthly") {
      const match = normalized.match(/^(\d{4})M(\d{1,2})$/i);
      if (match) {
        return { label: normalized, year: match[1], period: match[2] };
      }
    } else {
      const match = normalized.match(/^(\d{4})[-\s]?Q([1-4])$/i);
      if (match) {
        return { label: normalized, year: match[1], period: match[2] };
      }
      const numericMatch = normalized.match(/^(\d{4})\.(\d{1,2})$/);
      if (numericMatch) {
        return { label: normalized, year: numericMatch[1], period: numericMatch[2] };
      }
    }
    return { label: normalized, year: normalized, period: "" };
  };

  const compareLabels = (left: string, right: string) => {
    const leftParsed = formatQuarterLabel(left, selectedSheet);
    const rightParsed = formatQuarterLabel(right, selectedSheet);
    if (leftParsed.period && rightParsed.period) {
      const leftYear = Number(leftParsed.year);
      const rightYear = Number(rightParsed.year);
      if (!Number.isNaN(leftYear) && !Number.isNaN(rightYear) && leftYear !== rightYear) {
        return leftYear - rightYear;
      }
      const leftPeriodNumber = Number(leftParsed.period);
      const rightPeriodNumber = Number(rightParsed.period);
      if (!Number.isNaN(leftPeriodNumber) && !Number.isNaN(rightPeriodNumber)) {
        return leftPeriodNumber - rightPeriodNumber;
      }
    }
    const leftDate = Date.parse(left);
    const rightDate = Date.parse(right);
    if (!Number.isNaN(leftDate) && !Number.isNaN(rightDate) && leftDate !== rightDate) {
      return leftDate - rightDate;
    }
    return left.localeCompare(right);
  };

  const periodLabels = useMemo(
    () => plotResponse?.labels.map((label) => formatQuarterLabel(label, selectedSheet)) ?? [],
    [plotResponse, selectedSheet]
  );

  const tickValues = useMemo(
    () => plotResponse?.labels.map((_, index) => index) ?? [],
    [plotResponse]
  );

  const tickText = useMemo(() => periodLabels.map((entry) => entry.label), [periodLabels]);
  const yearsOnAxis = useMemo(
    () =>
      periodLabels
        .filter((entry, index, array) => entry.year && (index === 0 || entry.year !== array[index - 1].year))
        .map((entry) => entry.year),
    [periodLabels]
  );

  const loadFiles = async () => {
    const response = await fetch(`${API_BASE}/api/input-files`);
    const payload = (await response.json()) as InputFilesResponse;
    setInputFiles(payload.files);
    setSelectedFiles((prev) =>
      prev.length ? prev : payload.files.slice(0, 2).map((file) => file.id)
    );
  };

  useEffect(() => {
    loadFiles();
  }, []);

  const availableSheets = useMemo(() => {
    if (inputFiles.length === 0) return [];
    if (selectedFiles.length === 0) {
      const allSheets = new Set<string>();
      inputFiles.forEach((file) => file.sheets.forEach((sheet) => allSheets.add(sheet)));
      return Array.from(allSheets).sort();
    }
    const selectedEntries = selectedFiles
      .map((fileId) => inputFiles.find((entry) => entry.id === fileId))
      .filter((entry): entry is InputFile => Boolean(entry));
    if (selectedEntries.length === 0) return [];
    const intersection = selectedEntries[0].sheets.filter((sheet) =>
      selectedEntries.every((entry) => entry.sheets.includes(sheet))
    );
    return intersection.length ? intersection : selectedEntries[0].sheets;
  }, [inputFiles, selectedFiles]);

  useEffect(() => {
    if (availableSheets.length === 0) return;
    setSelectedSheet((prev) => (availableSheets.includes(prev) ? prev : availableSheets[0]));
  }, [availableSheets]);

  const availableSeries = useMemo(() => {
    const names = new Set<string>();
    const fileIds = selectedFiles.length ? selectedFiles : inputFiles.map((file) => file.id);
    fileIds.forEach((fileId) => {
      const file = inputFiles.find((entry) => entry.id === fileId);
      const seriesList = file?.series_by_sheet?.[selectedSheet] ?? [];
      seriesList.forEach((name) => names.add(name));
    });
    return Array.from(names).sort();
  }, [inputFiles, selectedFiles, selectedSheet]);

  useEffect(() => {
    if (availableSeries.length === 0) {
      setSelectedSeries("");
      return;
    }
    setSelectedSeries((prev) => (availableSeries.includes(prev) ? prev : availableSeries[0]));
  }, [availableSeries]);

  const periodsPerYear = selectedSheet === "Monthly" ? 12 : 4;
  const periodAdjective = selectedSheet === "Monthly" ? "Monthly" : "Quarterly";
  const periodNoun = selectedSheet === "Monthly" ? "month" : "quarter";

  const modeOptions = useMemo(
    () => [
      { value: "raw", label: "Original (raw)", description: "Plot the stored values as-is." },
      {
        value: "quarterly_change",
        label: `${periodAdjective} change`,
        description: `Change vs. the previous ${periodNoun}.`
      },
      {
        value: "quarterly_change_percent",
        label: `${periodAdjective} change (%)`,
        description: `Percent change vs. the previous ${periodNoun}.`
      },
      {
        value: "year_over_year",
        label: "Year-over-year change",
        description: `Change vs. the same ${periodNoun} in the prior year.`
      },
      {
        value: "year_over_year_percent",
        label: "Year-over-year change (%)",
        description: `Percent change vs. the same ${periodNoun} in the prior year.`
      },
      {
        value: "since_start",
        label: `Change vs. first ${periodNoun}`,
        description: `Change vs. the first selected ${periodNoun}.`
      },
      {
        value: "since_start_percent",
        label: `Change vs. first ${periodNoun} (%)`,
        description: `Percent change vs. the first selected ${periodNoun}.`
      }
    ],
    [periodAdjective, periodNoun]
  );

  const displayResponse = useMemo(() => {
    if (!plotResponse) return null;
    return {
      ...plotResponse,
      series: plotResponse.series.map((entry) => ({
        ...entry,
        values: deriveSeriesValues(entry.values, displayMode, periodsPerYear)
      }))
    };
  }, [plotResponse, displayMode, periodsPerYear]);

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
      const labels = file?.columns_by_sheet?.[selectedSheet] ?? [];
      labels.forEach((label) => merged.add(label));
    });
    return Array.from(merged).sort(compareLabels);
  }, [inputFiles, selectedFiles, selectedSheet]);

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
        end_label: endLabel || null,
        sheet_name: selectedSheet
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
  }, [selectedSeries, selectedFiles, startLabel, endLabel, selectedSheet]);

  const updateValue = async (fileId: string, label: string, value: number) => {
    const response = await fetch(`${API_BASE}/api/input-files/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_id: fileId,
        series_name: selectedSeries,
        label,
        value,
        sheet_name: selectedSheet
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
    const activeMode = modeOptions.find((option) => option.value === displayMode);
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
        setStatusMessage(`${periodAdjective} change needs a previous ${periodNoun} value.`);
        return;
      }
      nextRawValue = prior + nextValue;
    } else if (displayMode === "quarterly_change_percent") {
      const prior = rawSeries.values[pointIndex - 1];
      if (pointIndex === 0 || !isNumericValue(prior) || prior === 0) {
        setStatusMessage(`${periodAdjective} percent change needs a non-zero previous value.`);
        return;
      }
      nextRawValue = prior * (1 + nextValue / 100);
    } else if (displayMode === "year_over_year") {
      const prior = rawSeries.values[pointIndex - periodsPerYear];
      if (pointIndex < periodsPerYear || !isNumericValue(prior)) {
        setStatusMessage(
          `Year-over-year change needs a value from ${periodsPerYear} ${periodNoun}s earlier.`
        );
        return;
      }
      nextRawValue = prior + nextValue;
    } else if (displayMode === "year_over_year_percent") {
      const prior = rawSeries.values[pointIndex - periodsPerYear];
      if (pointIndex < periodsPerYear || !isNumericValue(prior) || prior === 0) {
        setStatusMessage(
          `Year-over-year percent change needs a non-zero value from ${periodsPerYear} ${periodNoun}s earlier.`
        );
        return;
      }
      nextRawValue = prior * (1 + nextValue / 100);
    } else if (displayMode === "since_start") {
      const baseline = rawSeries.values[0];
      if (!isNumericValue(baseline)) {
        setStatusMessage(`Change vs. first ${periodNoun} needs the first value to be set.`);
        return;
      }
      nextRawValue = baseline + nextValue;
    } else {
      const baseline = rawSeries.values[0];
      if (!isNumericValue(baseline) || baseline === 0) {
        setStatusMessage(`Percent change vs. first ${periodNoun} needs a non-zero first value.`);
        return;
      }
      nextRawValue = baseline * (1 + nextValue / 100);
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
                    {" "}
                    {file.name} ({file.series_by_sheet[selectedSheet]?.length ?? 0} series)
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
          Choose files to plot simultaneously. Each row in the CSV/Excel sheet is treated as a
          time-series entry with the Mnemonic column as the name.
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
              {modeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="notice">
              {modeOptions.find((option) => option.value === displayMode)?.description}
            </p>
          </div>
          <div>
            <label>Sheet</label>
            <select value={selectedSheet} onChange={(event) => setSelectedSheet(event.target.value)}>
              {availableSheets.map((sheet) => (
                <option key={sheet} value={sheet}>
                  {sheet}
                </option>
              ))}
            </select>
            <p className="notice">Choose the Excel sheet to plot (Quarterly or Monthly).</p>
          </div>
          <div>
            <label>Mnemonic</label>
            <input
              className="search-input"
              list="series-options"
              value={selectedSeries}
              onChange={(event) => setSelectedSeries(event.target.value)}
              onBlur={() => {
                if (!availableSeries.includes(selectedSeries) && availableSeries[0]) {
                  setSelectedSeries(availableSeries[0]);
                }
              }}
            />
            <datalist id="series-options">
              {availableSeries.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
        </div>
        <div className="grid">
          <div>
            <label>Start</label>
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
            <label>End</label>
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
                    title: `Series: ${selectedSeries} (${modeOptions.find((option) => option.value === displayMode)?.label ?? "Mode"})`,
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
              <p className="notice">
                {periodAdjective} spacing applied. Years shown: {yearsOnAxis.join(", ")}.
              </p>
            )}
            <p className="notice">Tip: click a legend item to isolate a track.</p>
          </>
        )}
      </section>
    </main>
  );
}
