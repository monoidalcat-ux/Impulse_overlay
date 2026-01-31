import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

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
    scenario?: string | null;
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
  const [originalPlotResponse, setOriginalPlotResponse] = useState<PlotResponse | null>(null);
  const [originalContextKey, setOriginalContextKey] = useState<string>("");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("raw");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [startLabel, setStartLabel] = useState<string>("");
  const [endLabel, setEndLabel] = useState<string>("");
  const [lockedSeries, setLockedSeries] = useState<string[]>([]);
  const originalSeriesByFileRef = useRef<Record<string, Record<string, number | null>>>({});
  const selectedSheet = "Quarterly";

  const formatQuarterLabel = (label: string): QuarterLabel => {
    const normalized = label.trim();
    const match = normalized.match(/^(\d{4})[-\s]?Q([1-4])$/i);
    if (match) {
      return { label: normalized, year: match[1], period: match[2] };
    }
    const numericMatch = normalized.match(/^(\d{4})\.(\d{1,2})$/);
    if (numericMatch) {
      return { label: normalized, year: numericMatch[1], period: numericMatch[2] };
    }
    return { label: normalized, year: normalized, period: "" };
  };

  const compareLabels = (left: string, right: string) => {
    const leftParsed = formatQuarterLabel(left);
    const rightParsed = formatQuarterLabel(right);
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

  const toSelectionKey = (seriesName: string, files: string[]) =>
    `${seriesName}::${[...files].sort().join(",")}`;

  const toOriginalSeriesMap = (payload: PlotResponse) =>
    payload.series.reduce<Record<string, Record<string, number | null>>>((acc, entry) => {
      const labelMap: Record<string, number | null> = {};
      payload.labels.forEach((label, index) => {
        labelMap[label] = entry.values[index] ?? null;
      });
      acc[entry.file] = labelMap;
      return acc;
    }, {});

  const toOriginalPlotResponse = (
    payload: PlotResponse,
    originalSeriesByFile: Record<string, Record<string, number | null>>
  ): PlotResponse => ({
    labels: payload.labels,
    series: payload.series.map((entry) => ({
      ...entry,
      values: payload.labels.map((label, index) => {
        const stored = originalSeriesByFile[entry.file]?.[label];
        return stored ?? entry.values[index] ?? null;
      })
    })),
    metadata: payload.metadata
  });

  const fadeColor = (color: string, alpha = 0.35) => {
    if (!color.startsWith("#") || (color.length !== 7 && color.length !== 4)) {
      return color;
    }
    const hex = color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color;
    const red = Number.parseInt(hex.slice(1, 3), 16);
    const green = Number.parseInt(hex.slice(3, 5), 16);
    const blue = Number.parseInt(hex.slice(5, 7), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  };

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

  const availableSeries = useMemo(() => {
    const names = new Set<string>();
    const fileIds = selectedFiles.length ? selectedFiles : inputFiles.map((file) => file.id);
    fileIds.forEach((fileId) => {
      const file = inputFiles.find((entry) => entry.id === fileId);
      const seriesList = file?.series_by_sheet?.[selectedSheet] ?? [];
      seriesList.forEach((name) => names.add(name));
    });
    return Array.from(names).sort();
  }, [inputFiles, selectedFiles]);

  useEffect(() => {
    if (availableSeries.length === 0) {
      setSelectedSeries("");
      return;
    }
    setSelectedSeries((prev) => (availableSeries.includes(prev) ? prev : availableSeries[0]));
  }, [availableSeries]);

  const periodsPerYear = 4;
  const periodAdjective = "Quarterly";
  const periodNoun = "quarter";

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

  const displayRange = useMemo(() => {
    if (!plotResponse || plotResponse.labels.length === 0) return null;
    let startIndex = 0;
    let endIndex = plotResponse.labels.length - 1;
    if (startLabel) {
      const foundStart = plotResponse.labels.indexOf(startLabel);
      if (foundStart !== -1) startIndex = foundStart;
    }
    if (endLabel) {
      const foundEnd = plotResponse.labels.indexOf(endLabel);
      if (foundEnd !== -1) endIndex = foundEnd;
    }
    if (startIndex > endIndex) {
      const swap = startIndex;
      startIndex = endIndex;
      endIndex = swap;
    }
    return { startIndex, endIndex };
  }, [plotResponse, startLabel, endLabel]);

  const displayResponse = useMemo(() => {
    if (!plotResponse) return null;
    const range = displayRange ?? { startIndex: 0, endIndex: plotResponse.labels.length - 1 };
    const slice = (values: (number | null)[]) =>
      values.slice(range.startIndex, range.endIndex + 1);
    const needsHistory = [
      "quarterly_change",
      "quarterly_change_percent",
      "year_over_year",
      "year_over_year_percent"
    ].includes(displayMode);
    return {
      ...plotResponse,
      labels: slice(plotResponse.labels),
      series: plotResponse.series.map((entry) => {
        if (needsHistory) {
          const derived = deriveSeriesValues(entry.values, displayMode, periodsPerYear);
          return { ...entry, values: slice(derived) };
        }
        const slicedValues = slice(entry.values);
        return {
          ...entry,
          values: deriveSeriesValues(slicedValues, displayMode, periodsPerYear)
        };
      })
    };
  }, [plotResponse, displayRange, displayMode]);

  const originalDisplayResponse = useMemo(() => {
    if (!originalPlotResponse) return null;
    const range = displayRange ?? {
      startIndex: 0,
      endIndex: originalPlotResponse.labels.length - 1
    };
    const slice = (values: (number | null)[]) =>
      values.slice(range.startIndex, range.endIndex + 1);
    const needsHistory = [
      "quarterly_change",
      "quarterly_change_percent",
      "year_over_year",
      "year_over_year_percent"
    ].includes(displayMode);
    return {
      ...originalPlotResponse,
      labels: slice(originalPlotResponse.labels),
      series: originalPlotResponse.series.map((entry) => {
        if (needsHistory) {
          const derived = deriveSeriesValues(entry.values, displayMode, periodsPerYear);
          return { ...entry, values: slice(derived) };
        }
        const slicedValues = slice(entry.values);
        return {
          ...entry,
          values: deriveSeriesValues(slicedValues, displayMode, periodsPerYear)
        };
      })
    };
  }, [originalPlotResponse, displayRange, displayMode]);

  const periodLabels = useMemo(
    () => displayResponse?.labels.map((label) => formatQuarterLabel(label)) ?? [],
    [displayResponse]
  );

  const tickValues = useMemo(() => {
    const labels = displayResponse?.labels ?? [];
    const maxTicks = 12;
    if (labels.length === 0) return [];
    const step = labels.length > maxTicks ? Math.ceil(labels.length / maxTicks) : 1;
    return labels
      .map((_, index) => index)
      .filter((index) => index % step === 0 || index === labels.length - 1);
  }, [displayResponse]);

  const tickText = useMemo(() => {
    if (!displayResponse || tickValues.length === 0) return [];
    return tickValues.map((index) =>
      formatQuarterLabel(displayResponse.labels[index] ?? "").label
    );
  }, [displayResponse, tickValues]);
  const yearsOnAxis = useMemo(
    () =>
      periodLabels
        .filter((entry, index, array) => entry.year && (index === 0 || entry.year !== array[index - 1].year))
        .map((entry) => entry.year),
    [periodLabels]
  );

  const colorByFile = useMemo(() => {
    if (!plotResponse) return {};
    const palette = [
      "#2563eb",
      "#f97316",
      "#16a34a",
      "#e11d48",
      "#7c3aed",
      "#0d9488",
      "#f59e0b",
      "#3b82f6",
      "#ec4899",
      "#84cc16"
    ];
    return plotResponse.series.reduce<Record<string, string>>((acc, entry, index) => {
      acc[entry.file] = palette[index % palette.length];
      return acc;
    }, {});
  }, [plotResponse]);

  const legendRankByFile = useMemo(() => {
    if (!plotResponse) return {};
    return plotResponse.series.reduce<Record<string, number>>((acc, entry, index) => {
      acc[entry.file] = index + 1;
      return acc;
    }, {});
  }, [plotResponse]);

  const hasChangesByFile = useMemo(() => {
    if (!plotResponse || !originalPlotResponse) return {};
    return plotResponse.series.reduce<Record<string, boolean>>((acc, entry) => {
      const originalEntry = originalPlotResponse.series.find((item) => item.file === entry.file);
      if (!originalEntry) {
        acc[entry.file] = false;
        return acc;
      }
      acc[entry.file] = entry.values.some(
        (value, index) => value !== originalEntry.values[index]
      );
      return acc;
    }, {});
  }, [plotResponse, originalPlotResponse]);

  const plotData = useMemo(() => {
    if (!displayResponse) return [];
    const locked: string[] = [];
    const unlocked: string[] = [];
    displayResponse.series.forEach((entry) => {
      if (lockedSeries.includes(entry.file)) {
        locked.push(entry.file);
      } else {
        unlocked.push(entry.file);
      }
    });
    const orderedFiles = [...locked, ...unlocked];
    return orderedFiles.flatMap((fileId) => {
      const seriesEntry = displayResponse.series.find((entry) => entry.file === fileId);
      if (!seriesEntry) return [];
      const originalEntry = originalDisplayResponse?.series.find((entry) => entry.file === fileId);
      const isLocked = lockedSeries.includes(fileId);
      const seriesColor = colorByFile[fileId] ?? "#2563eb";
      const fadedColor = fadeColor(seriesColor);
      const legendRank = legendRankByFile[fileId] ?? 0;
      const hasChanges = hasChangesByFile[fileId];
      const nameBase = seriesEntry.scenario?.trim() || fileId;
      const xValues = displayResponse.labels.map((_, index) => index);
      const makeTrace = (
        values: (number | null)[],
        name: string,
        options: {
          color: string;
          dash?: "dash" | "solid";
          opacity?: number;
        }
      ) => ({
        x: xValues,
        y: displayResponse.labels.map((_, index) => values[index] ?? null),
        type: "scatter",
        mode: "lines+markers",
        name,
        legendrank: legendRank,
        opacity: isLocked ? 0.4 : options.opacity ?? 1,
        marker: { size: 8, color: options.color },
        line: { color: options.color, dash: options.dash },
        connectgaps: false,
        customdata: displayResponse.labels,
        meta: { fileId },
        hovertemplate: "%{customdata}<br>Value: %{y}<extra></extra>"
      });
      if (hasChanges && originalEntry) {
        return [
          makeTrace(originalEntry.values, `${nameBase} (original)`, {
            color: fadedColor,
            dash: "dash",
            opacity: 0.9
          }),
          makeTrace(seriesEntry.values, `${nameBase} (modified)`, {
            color: seriesColor,
            dash: "solid"
          })
        ];
      }
      return [
        makeTrace(seriesEntry.values, nameBase, {
          color: seriesColor,
          dash: "solid"
        })
      ];
    });
  }, [
    displayResponse,
    originalDisplayResponse,
    lockedSeries,
    colorByFile,
    legendRankByFile,
    hasChangesByFile
  ]);

  const availableLabels = useMemo(() => {
    if (selectedFiles.length === 0) return [];
    const merged = new Set<string>();
    selectedFiles.forEach((fileId) => {
      const file = inputFiles.find((entry) => entry.id === fileId);
      const labels = file?.columns_by_sheet?.[selectedSheet] ?? [];
      labels.forEach((label) => merged.add(label));
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
    let calcStartLabel = startLabel || null;
    if (startLabel && availableLabels.length) {
      const startIndex = availableLabels.indexOf(startLabel);
      if (startIndex > 0) {
        const lookbackIndex = Math.max(0, startIndex - periodsPerYear);
        calcStartLabel = availableLabels[lookbackIndex] ?? startLabel;
      }
    }
    const response = await fetch(`${API_BASE}/api/plot-series`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        series_name: selectedSeries,
        files: selectedFiles,
        start_label: calcStartLabel,
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
    const nextContextKey = toSelectionKey(selectedSeries, selectedFiles);
    const shouldResetOriginal = nextContextKey !== originalContextKey;
    if (shouldResetOriginal) {
      originalSeriesByFileRef.current = toOriginalSeriesMap(payload);
      setOriginalContextKey(nextContextKey);
      setOriginalPlotResponse(payload);
      setPlotResponse(payload);
      return;
    }
    const originalSeriesByFile = originalSeriesByFileRef.current;
    payload.series.forEach((entry) => {
      if (!originalSeriesByFile[entry.file]) {
        originalSeriesByFile[entry.file] = {};
      }
      payload.labels.forEach((label, index) => {
        if (!(label in originalSeriesByFile[entry.file])) {
          originalSeriesByFile[entry.file][label] = entry.values[index] ?? null;
        }
      });
    });
    setOriginalPlotResponse(toOriginalPlotResponse(payload, originalSeriesByFile));
    setPlotResponse(payload);
  };

  useEffect(() => {
    if (!plotResponse || !selectedSeries || selectedFiles.length === 0) return;
    void fetchPlot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSeries, selectedFiles, startLabel, endLabel]);

  useEffect(() => {
    setLockedSeries((prev) => prev.filter((fileId) => selectedFiles.includes(fileId)));
  }, [selectedFiles]);

  const handleLegendClick = (event: {
    curveNumber: number;
    data?: Array<{ meta?: { fileId?: string } }>;
  }) => {
    const fileId = event.data?.[event.curveNumber]?.meta?.fileId;
    if (!fileId) return false;
    setLockedSeries((prev) =>
      prev.includes(fileId) ? prev.filter((entry) => entry !== fileId) : [...prev, fileId]
    );
    return false;
  };

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
    setStatusMessage(`Updated ${fileId} at ${label}.`);
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
        ? { labels: prev.labels, series: updatedSeries, metadata: prev.metadata }
        : null;
    });
    setOriginalPlotResponse((prev) => {
      if (!prev) return prev;
      const updatedSeries = prev.series.filter((entry) => entry.file !== fileId);
      return updatedSeries.length
        ? { labels: prev.labels, series: updatedSeries, metadata: prev.metadata }
        : null;
    });
    delete originalSeriesByFileRef.current[fileId];
    setStatusMessage(`Removed ${fileId}.`);
  };

  const handlePointClick = (event: {
    points?: Array<{ curveNumber: number; pointNumber: number; y?: number | null }>;
  }) => {
    if (!plotResponse || !displayResponse || !event.points || event.points.length === 0) return;
    const point = event.points[0];
    const traceIndex = point.curveNumber;
    const pointIndex = point.pointNumber;
    const seriesEntry = plotData[traceIndex] as { meta?: { fileId?: string } } | undefined;
    const fileId = seriesEntry?.meta?.fileId;
    if (!fileId) return;
    if (lockedSeries.includes(fileId)) {
      setStatusMessage("Series is locked. Use the legend to unlock it before editing.");
      return;
    }
    const rangeStartIndex = displayRange?.startIndex ?? 0;
    const rawIndex = rangeStartIndex + pointIndex;
    const currentValue =
      point.y ??
      displayResponse.series.find((entry) => entry.file === fileId)?.values?.[pointIndex] ??
      "";
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
    const rawSeries = plotResponse.series.find((entry) => entry.file === fileId);
    if (!rawSeries) return;
    let nextRawValue: number | null = null;
    if (displayMode === "raw") {
      nextRawValue = nextValue;
    } else if (displayMode === "quarterly_change") {
      const prior = rawSeries.values[rawIndex - 1];
      if (rawIndex === 0 || !isNumericValue(prior)) {
        setStatusMessage(`${periodAdjective} change needs a previous ${periodNoun} value.`);
        return;
      }
      nextRawValue = prior + nextValue;
    } else if (displayMode === "quarterly_change_percent") {
      const prior = rawSeries.values[rawIndex - 1];
      if (rawIndex === 0 || !isNumericValue(prior) || prior === 0) {
        setStatusMessage(`${periodAdjective} percent change needs a non-zero previous value.`);
        return;
      }
      nextRawValue = prior * (1 + nextValue / 100);
    } else if (displayMode === "year_over_year") {
      const prior = rawSeries.values[rawIndex - periodsPerYear];
      if (rawIndex < periodsPerYear || !isNumericValue(prior)) {
        setStatusMessage(
          `Year-over-year change needs a value from ${periodsPerYear} ${periodNoun}s earlier.`
        );
        return;
      }
      nextRawValue = prior + nextValue;
    } else if (displayMode === "year_over_year_percent") {
      const prior = rawSeries.values[rawIndex - periodsPerYear];
      if (rawIndex < periodsPerYear || !isNumericValue(prior) || prior === 0) {
        setStatusMessage(
          `Year-over-year percent change needs a non-zero value from ${periodsPerYear} ${periodNoun}s earlier.`
        );
        return;
      }
      nextRawValue = prior * (1 + nextValue / 100);
    } else if (displayMode === "since_start") {
      const baseline = rawSeries.values[rangeStartIndex];
      if (!isNumericValue(baseline)) {
        setStatusMessage(`Change vs. first ${periodNoun} needs the first value to be set.`);
        return;
      }
      nextRawValue = baseline + nextValue;
    } else {
      const baseline = rawSeries.values[rangeStartIndex];
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
      const updatedSeries = prev.series.map((entry) => ({ ...entry }));
      const target = updatedSeries.find((entry) => entry.file === fileId);
      if (!target) return prev;
      target.values[rawIndex] = nextRawValue;
      return {
        labels: prev.labels,
        series: updatedSeries,
        metadata: prev.metadata
      };
    });
    void updateValue(
      fileId,
      plotResponse.labels[rawIndex],
      nextRawValue
    );
  };

  return (
    <main>
      <h1>Impulse Overlay – Financial Time Series</h1>

      <section className="card">
        <div className="section-title">1) Upload & available files</div>
        <input type="file" accept=".csv,.xlsx" onChange={handleUpload} />
        {statusMessage && <p className="notice">Upload status: {statusMessage}</p>}
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
        {plotResponse && (
          <>
            <div className="plot-area">
              <div className="plot-panel">
                <Plot
                  data={plotData}
                  layout={{
                    title: `Series: ${selectedSeries} (${modeOptions.find((option) => option.value === displayMode)?.label ?? "Mode"})`,
                    height: 520,
                    margin: { t: 50, r: 30, l: 50, b: 120 },
                    legend: {
                      orientation: "h",
                      x: 0,
                      y: -0.2,
                      xanchor: "left",
                      yanchor: "top"
                    },
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
                  onLegendClick={handleLegendClick}
                />
              </div>
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
