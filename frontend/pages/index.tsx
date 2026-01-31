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

type NameListResponse = {
  active: boolean;
  names: string[];
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

type PercentileBucket = {
  order: number;
  values: Record<number, number | null>;
};

const API_BASE = "http://localhost:8000";

const isNumericValue = (value: number | null | undefined): value is number =>
  typeof value === "number" && !Number.isNaN(value);

const percentileLevels = [99, 95, 90, 75, 50, 25, 10, 5, 1];

const deriveSeriesValues = (
  values: (number | null)[],
  mode: DisplayMode,
  periodsPerYear: number,
  baselineIndex = 0
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
      if (index < baselineIndex) return null;
      const baseline = array[baselineIndex];
      if (!isNumericValue(baseline)) return null;
      return value - baseline;
    }
    if (index < baselineIndex) return null;
    const baseline = array[baselineIndex];
    if (!isNumericValue(baseline) || baseline === 0) return null;
    return ((value - baseline) / baseline) * 100;
  });
};

const calculateDifferences = (values: (number | null)[], order: number): number[] => {
  let current = [...values];
  for (let step = 0; step < order; step += 1) {
    const next: (number | null)[] = [];
    for (let index = 1; index < current.length; index += 1) {
      const currentValue = current[index];
      const previousValue = current[index - 1];
      if (!isNumericValue(currentValue) || !isNumericValue(previousValue)) {
        next.push(null);
      } else {
        next.push(currentValue - previousValue);
      }
    }
    current = next;
  }
  return current.filter(isNumericValue);
};

const calculatePercentile = (values: number[], percentile: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (percentile / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const weight = position - lowerIndex;
  return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * weight;
};

const calculatePercentileRank = (values: number[], target: number) => {
  if (values.length === 0) return null;
  let belowCount = 0;
  let equalCount = 0;
  values.forEach((value) => {
    if (value < target) {
      belowCount += 1;
    } else if (value === target) {
      equalCount += 1;
    }
  });
  return ((belowCount + equalCount * 0.5) / values.length) * 100;
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
  const [nameListMessage, setNameListMessage] = useState<string>("");
  const [quarterZeroLabel, setQuarterZeroLabel] = useState<string>("");
  const [percentileInput, setPercentileInput] = useState<string>("");
  const [visibleRange, setVisibleRange] = useState<{ startIndex: number; endIndex: number } | null>(
    null
  );
  const [lockedSeries, setLockedSeries] = useState<string[]>([]);
  const [nameList, setNameList] = useState<string[] | null>(null);
  const originalSeriesByFileRef = useRef<Record<string, Record<string, number | null>>>({});
  const lastQuarterZeroRef = useRef<string>("");
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
    labels: [...payload.labels],
    series: payload.series.map((entry) => ({
      ...entry,
      values: payload.labels.map((label, index) => {
        const stored = originalSeriesByFile[entry.file]?.[label];
        return stored ?? entry.values[index] ?? null;
      })
    })),
    metadata: { ...payload.metadata }
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

  const loadNameList = async () => {
    const response = await fetch(`${API_BASE}/api/name-list`);
    const payload = (await response.json()) as NameListResponse;
    setNameList(payload.active ? payload.names : null);
  };

  useEffect(() => {
    loadFiles();
    loadNameList();
  }, []);

  const availableSeries = useMemo(() => {
    const names = new Set<string>();
    const fileIds = selectedFiles.length ? selectedFiles : inputFiles.map((file) => file.id);
    fileIds.forEach((fileId) => {
      const file = inputFiles.find((entry) => entry.id === fileId);
      const seriesList = file?.series_by_sheet?.[selectedSheet] ?? [];
      seriesList.forEach((name) => names.add(name));
    });
    if (!nameList) {
      return Array.from(names).sort();
    }
    const allowed = new Set(nameList);
    return Array.from(names).filter((name) => allowed.has(name)).sort();
  }, [inputFiles, selectedFiles, nameList]);

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

  const quarterZeroIndex = useMemo(() => {
    if (!plotResponse || plotResponse.labels.length === 0) return 0;
    if (!quarterZeroLabel) return 0;
    const index = plotResponse.labels.indexOf(quarterZeroLabel);
    return index === -1 ? 0 : index;
  }, [plotResponse, quarterZeroLabel]);

  const displayRange = useMemo(() => {
    if (!plotResponse || plotResponse.labels.length === 0) return null;
    if (visibleRange) {
      const startIndex = Math.max(0, Math.min(visibleRange.startIndex, plotResponse.labels.length - 1));
      const endIndex = Math.max(
        startIndex,
        Math.min(visibleRange.endIndex, plotResponse.labels.length - 1)
      );
      return { startIndex, endIndex };
    }
    return { startIndex: 0, endIndex: plotResponse.labels.length - 1 };
  }, [plotResponse, visibleRange]);

  const displayValuesByFile = useMemo(() => {
    if (!plotResponse) return {};
    return plotResponse.series.reduce<Record<string, (number | null)[]>>((acc, entry) => {
      acc[entry.file] = deriveSeriesValues(
        entry.values,
        displayMode,
        periodsPerYear,
        quarterZeroIndex
      );
      return acc;
    }, {});
  }, [plotResponse, displayMode, periodsPerYear, quarterZeroIndex]);

  const originalDisplayValuesByFile = useMemo(() => {
    if (!originalPlotResponse) return {};
    return originalPlotResponse.series.reduce<Record<string, (number | null)[]>>((acc, entry) => {
      acc[entry.file] = deriveSeriesValues(
        entry.values,
        displayMode,
        periodsPerYear,
        quarterZeroIndex
      );
      return acc;
    }, {});
  }, [originalPlotResponse, displayMode, periodsPerYear, quarterZeroIndex]);

  const displayLabels = useMemo(() => {
    if (!plotResponse || !displayRange) return [];
    return plotResponse.labels.slice(displayRange.startIndex, displayRange.endIndex + 1);
  }, [plotResponse, displayRange]);

  const periodLabels = useMemo(
    () => displayLabels.map((label) => formatQuarterLabel(label)),
    [displayLabels]
  );

  const tickValues = useMemo(() => {
    if (!plotResponse || !displayRange) return [];
    const maxTicks = 12;
    const rangeLength = displayRange.endIndex - displayRange.startIndex + 1;
    if (rangeLength <= 0) return [];
    const step = Math.max(1, Math.ceil(rangeLength / maxTicks));
    const ticks: number[] = [];
    for (let index = displayRange.startIndex; index <= displayRange.endIndex; index += step) {
      ticks.push(index);
    }
    if (ticks[ticks.length - 1] !== displayRange.endIndex) {
      ticks.push(displayRange.endIndex);
    }
    return ticks;
  }, [plotResponse, displayRange]);

  const tickText = useMemo(() => {
    if (!plotResponse || tickValues.length === 0) return [];
    return tickValues.map((index) =>
      formatQuarterLabel(plotResponse.labels[index] ?? "").label
    );
  }, [plotResponse, tickValues]);

  const historicalPercentiles = useMemo<PercentileBucket[]>(() => {
    if (!originalPlotResponse || originalPlotResponse.series.length === 0) return [];
    const referenceSeries = originalPlotResponse.series[0];
    const referenceValues = deriveSeriesValues(
      referenceSeries.values,
      displayMode,
      periodsPerYear,
      quarterZeroIndex
    );
    const historySlice = referenceValues.slice(0, Math.max(0, quarterZeroIndex));
    return [2, 3, 4, 5].map((order) => {
      const differenceValues = calculateDifferences(historySlice, order);
      const values = percentileLevels.reduce<Record<number, number | null>>((acc, level) => {
        acc[level] = calculatePercentile(differenceValues, level);
        return acc;
      }, {});
      return { order, values };
    });
  }, [originalPlotResponse, displayMode, periodsPerYear, quarterZeroIndex]);

  const historicalDifferenceValues = useMemo(() => {
    if (!originalPlotResponse || originalPlotResponse.series.length === 0) return {};
    const referenceSeries = originalPlotResponse.series[0];
    const referenceValues = deriveSeriesValues(
      referenceSeries.values,
      displayMode,
      periodsPerYear,
      quarterZeroIndex
    );
    const historySlice = referenceValues.slice(0, Math.max(0, quarterZeroIndex));
    return [2, 3, 4, 5].reduce<Record<number, number[]>>((acc, order) => {
      acc[order] = calculateDifferences(historySlice, order);
      return acc;
    }, {});
  }, [originalPlotResponse, displayMode, periodsPerYear, quarterZeroIndex]);

  const percentileInputValue = useMemo(() => {
    if (!percentileInput.trim()) return null;
    const parsed = Number(percentileInput);
    return Number.isFinite(parsed) ? parsed : null;
  }, [percentileInput]);

  const historicalPercentileRanks = useMemo(() => {
    if (percentileInputValue === null) return {};
    return [2, 3, 4, 5].reduce<Record<number, number | null>>((acc, order) => {
      const values = historicalDifferenceValues[order] ?? [];
      acc[order] = calculatePercentileRank(values, percentileInputValue);
      return acc;
    }, {});
  }, [historicalDifferenceValues, percentileInputValue]);

  const formatPercentileValue = (value: number | null) => {
    if (!isNumericValue(value)) return "—";
    const formatter = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 3
    });
    return formatter.format(value);
  };

  const formatPercentileRank = (value: number | null) => {
    if (!isNumericValue(value)) return "—";
    const formatter = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 1
    });
    return `${formatter.format(value)}%`;
  };
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
    if (!plotResponse) return [];
    const locked: string[] = [];
    const unlocked: string[] = [];
    plotResponse.series.forEach((entry) => {
      if (lockedSeries.includes(entry.file)) {
        locked.push(entry.file);
      } else {
        unlocked.push(entry.file);
      }
    });
    const orderedFiles = [...locked, ...unlocked];
    return orderedFiles.flatMap((fileId) => {
      const seriesEntry = plotResponse.series.find((entry) => entry.file === fileId);
      if (!seriesEntry) return [];
      const originalEntry = originalPlotResponse?.series.find((entry) => entry.file === fileId);
      const isLocked = lockedSeries.includes(fileId);
      const seriesColor = colorByFile[fileId] ?? "#2563eb";
      const fadedColor = fadeColor(seriesColor);
      const legendRank = legendRankByFile[fileId] ?? 0;
      const hasChanges = hasChangesByFile[fileId];
      const nameBase = seriesEntry.scenario?.trim() || fileId;
      const xValues = plotResponse.labels.map((_, index) => index);
      const makeLineTrace = (
        values: (number | null)[],
        name: string,
        options: {
          color: string;
          dash?: "dash" | "solid";
          opacity?: number;
          isOriginal?: boolean;
        }
      ) => ({
        x: xValues,
        y: plotResponse.labels.map((_, index) => values[index] ?? null),
        type: "scatter",
        mode: "lines",
        name,
        legendrank: legendRank,
        opacity: isLocked ? 0.4 : options.opacity ?? 1,
        line: { color: options.color, dash: options.dash },
        connectgaps: false,
        customdata: plotResponse.labels,
        meta: { fileId, isOriginal: options.isOriginal ?? false },
        hovertemplate: "%{customdata}<br>Value: %{y}<extra></extra>"
      });
      const makeMarkerTrace = (
        values: (number | null)[],
        options: { color: string; opacity?: number; isOriginal?: boolean }
      ) => ({
        x: xValues,
        y: plotResponse.labels.map((_, index) => values[index] ?? null),
        type: "scatter",
        mode: "markers",
        showlegend: false,
        opacity: isLocked ? 0.4 : options.opacity ?? 1,
        marker: { size: 8, color: options.color },
        connectgaps: false,
        customdata: plotResponse.labels,
        meta: { fileId, isOriginal: options.isOriginal ?? false },
        hovertemplate: "%{customdata}<br>Value: %{y}<extra></extra>",
        xaxis: "x2"
      });
      if (hasChanges && originalEntry) {
        const originalValues = originalDisplayValuesByFile[fileId] ?? originalEntry.values;
        const modifiedValues = displayValuesByFile[fileId] ?? seriesEntry.values;
        return [
          makeLineTrace(originalValues, `${nameBase} (original)`, {
            color: fadedColor,
            dash: "dash",
            opacity: 0.9,
            isOriginal: true
          }),
          makeMarkerTrace(originalValues, {
            color: fadedColor,
            opacity: 0.9,
            isOriginal: true
          }),
          makeLineTrace(modifiedValues, `${nameBase} (modified)`, {
            color: seriesColor,
            dash: "solid"
          }),
          makeMarkerTrace(modifiedValues, {
            color: seriesColor
          })
        ];
      }
      const values = displayValuesByFile[fileId] ?? seriesEntry.values;
      return [
        makeLineTrace(values, nameBase, {
          color: seriesColor,
          dash: "solid"
        }),
        makeMarkerTrace(values, {
          color: seriesColor
        })
      ];
    });
  }, [
    plotResponse,
    displayValuesByFile,
    originalDisplayValuesByFile,
    lockedSeries,
    colorByFile,
    legendRankByFile,
    hasChangesByFile
  ]);

  const highlightShapes = useMemo(() => {
    if (!plotResponse || plotResponse.labels.length === 0) return [];
    const startIndex = Math.max(0, quarterZeroIndex);
    const endIndex = Math.min(plotResponse.labels.length - 1, startIndex + 12);
    return [
      {
        type: "rect",
        xref: "x",
        yref: "paper",
        x0: startIndex - 0.5,
        x1: endIndex + 0.5,
        y0: 0,
        y1: 1,
        fillcolor: "rgba(203, 213, 225, 0.45)",
        line: { width: 0 },
        layer: "below"
      }
    ];
  }, [plotResponse, quarterZeroIndex]);

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
      setQuarterZeroLabel("");
      return;
    }
    setQuarterZeroLabel((prev) => (availableLabels.includes(prev) ? prev : availableLabels[0]));
  }, [availableLabels]);

  useEffect(() => {
    if (!plotResponse || plotResponse.labels.length === 0) {
      setVisibleRange(null);
      lastQuarterZeroRef.current = "";
      return;
    }
    const defaultPadding = 3;
    const resolvedQuarterZero =
      quarterZeroLabel && plotResponse.labels.includes(quarterZeroLabel)
        ? quarterZeroLabel
        : plotResponse.labels[0];
    if (!visibleRange || resolvedQuarterZero !== lastQuarterZeroRef.current) {
      const startIndex = plotResponse.labels.indexOf(resolvedQuarterZero);
      const safeStart = Math.max(0, startIndex);
      const paddedStart = Math.max(0, safeStart - defaultPadding);
      const endIndex = Math.min(
        plotResponse.labels.length - 1,
        safeStart + 12 + defaultPadding
      );
      setVisibleRange({ startIndex: paddedStart, endIndex });
      lastQuarterZeroRef.current = resolvedQuarterZero;
    }
  }, [plotResponse, quarterZeroLabel, visibleRange]);

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
    const selectedFiles = Array.from(event.target.files ?? []);
    if (selectedFiles.length === 0) return;
    const formData = new FormData();
    selectedFiles.forEach((file) => {
      formData.append("files", file);
    });
    const response = await fetch(`${API_BASE}/api/input-files/upload`, {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      const error = await response.json();
      setStatusMessage(error.detail ?? "Unable to upload files.");
      return;
    }
    await loadFiles();
    setStatusMessage(`Uploaded ${selectedFiles.map((file) => file.name).join(", ")}.`);
    event.target.value = "";
  };

  const handleNameListUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch(`${API_BASE}/api/name-list/upload`, {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      const error = await response.json();
      setNameListMessage(error.detail ?? "Unable to upload name list.");
      return;
    }
    const payload = (await response.json()) as NameListResponse;
    setNameList(payload.active ? payload.names : null);
    setNameListMessage(
      payload.active ? `Loaded ${payload.names.length} names.` : "Name list cleared."
    );
    event.target.value = "";
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
        start_label: null,
        end_label: null,
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
      const originalSeriesMap = toOriginalSeriesMap(payload);
      originalSeriesByFileRef.current = originalSeriesMap;
      setOriginalContextKey(nextContextKey);
      setOriginalPlotResponse(toOriginalPlotResponse(payload, originalSeriesMap));
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
  }, [selectedSeries, selectedFiles]);

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
    if (!plotResponse || !event.points || event.points.length === 0) return;
    const point = event.points[0];
    const traceIndex = point.curveNumber;
    const pointIndex = point.pointNumber;
    const seriesEntry = plotData[traceIndex] as
      | { meta?: { fileId?: string; isOriginal?: boolean } }
      | undefined;
    const fileId = seriesEntry?.meta?.fileId;
    if (!fileId) return;
    if (seriesEntry?.meta?.isOriginal) {
      setStatusMessage("Original series is read-only. Edit the solid line instead.");
      return;
    }
    if (lockedSeries.includes(fileId)) {
      setStatusMessage("Series is locked. Use the legend to unlock it before editing.");
      return;
    }
    const baselineIndex = quarterZeroIndex;
    const rawIndex = pointIndex;
    const currentValue =
      point.y ??
      displayValuesByFile[fileId]?.[pointIndex] ??
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
      const baseline = rawSeries.values[baselineIndex];
      if (!isNumericValue(baseline)) {
        setStatusMessage(`Change vs. first ${periodNoun} needs the first value to be set.`);
        return;
      }
      nextRawValue = baseline + nextValue;
    } else {
      const baseline = rawSeries.values[baselineIndex];
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

  const handleRangeRelayout = (event: Record<string, unknown>) => {
    if (!plotResponse || plotResponse.labels.length === 0) return;
    const rangeFromEvent = event["xaxis.range"];
    const startValue =
      event["xaxis.range[0]"] ??
      (Array.isArray(rangeFromEvent) ? rangeFromEvent[0] : undefined);
    const endValue =
      event["xaxis.range[1]"] ??
      (Array.isArray(rangeFromEvent) ? rangeFromEvent[1] : undefined);
    if (startValue === undefined || endValue === undefined) return;
    const parsedStart = Number(startValue);
    const parsedEnd = Number(endValue);
    if (Number.isNaN(parsedStart) || Number.isNaN(parsedEnd)) return;
    let nextStart = Math.round(parsedStart);
    let nextEnd = Math.round(parsedEnd);
    if (nextStart > nextEnd) {
      const swap = nextStart;
      nextStart = nextEnd;
      nextEnd = swap;
    }
    nextStart = Math.max(0, Math.min(nextStart, plotResponse.labels.length - 1));
    nextEnd = Math.max(nextStart, Math.min(nextEnd, plotResponse.labels.length - 1));
    if (nextEnd - nextStart < 1) {
      nextEnd = Math.min(plotResponse.labels.length - 1, nextStart + 1);
    }
    setVisibleRange((prev) => {
      if (prev && prev.startIndex === nextStart && prev.endIndex === nextEnd) {
        return prev;
      }
      return { startIndex: nextStart, endIndex: nextEnd };
    });
  };

  return (
    <main>
      <h1>Impulse Overlay – Financial Time Series</h1>

      <section className="card">
        <div className="section-title">1) Upload & available files</div>
        <input type="file" accept=".csv,.xlsx" multiple onChange={handleUpload} />
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
        <div className="section-title">Name list filter (optional)</div>
        <input type="file" accept=".xlsx" onChange={handleNameListUpload} />
        {nameListMessage && <p className="notice">Name list status: {nameListMessage}</p>}
        <p className="notice">
          Upload an Excel file with a single sheet and a Mnemonic column to limit the Mnemonic
          suggestions. {nameList ? `Currently filtering to ${nameList.length} names.` : "No name list loaded."}
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
            <label>Quarter 0</label>
            <input
              className="search-input"
              list="quarter-zero-options"
              value={quarterZeroLabel}
              onChange={(event) => setQuarterZeroLabel(event.target.value)}
              onBlur={() => {
                if (!availableLabels.includes(quarterZeroLabel) && availableLabels[0]) {
                  setQuarterZeroLabel(availableLabels[0]);
                }
              }}
            />
            <datalist id="quarter-zero-options">
              {availableLabels.map((label) => (
                <option key={label} value={label} />
              ))}
            </datalist>
            <p className="notice">
              Quarter 0 anchors the highlighted 13-quarter window; use the scrollbar to move the
              viewing range.
            </p>
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
                    height: 640,
                    margin: { t: 50, r: 30, l: 50, b: 200 },
                    legend: {
                      orientation: "h",
                      x: 0,
                      y: -0.5,
                      xanchor: "left",
                      yanchor: "top"
                    },
                    hovermode: "closest",
                    dragmode: false,
                    shapes: highlightShapes,
                    xaxis: {
                      tickmode: "array",
                      tickvals: tickValues,
                      ticktext: tickText,
                      tickangle: -45,
                      automargin: true,
                      fixedrange: true,
                      rangeslider: {
                        visible: true,
                        thickness: 0.12,
                        bgcolor: "#e5e7eb",
                        bordercolor: "#9ca3af",
                        borderwidth: 1
                      },
                      range: displayRange
                        ? [displayRange.startIndex, displayRange.endIndex]
                        : undefined
                    },
                    xaxis2: {
                      overlaying: "x",
                      matches: "x",
                      showticklabels: false,
                      showgrid: false,
                      zeroline: false
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
                  onRelayout={handleRangeRelayout}
                />
              </div>
              <div className="percentile-panel">
                <div className="percentile-title">Historical Δ²Q–Δ⁵Q percentiles</div>
                <div className="percentile-subtitle">
                  Calculated from the pre-Quarter 0 history in the current display mode.
                </div>
                <table className="percentile-table">
                  <thead>
                    <tr>
                      <th aria-hidden="true" />
                      {historicalPercentiles.map((bucket) => (
                        <th key={bucket.order}>
                          Δ<sup>{bucket.order}</sup>Q
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {percentileLevels.map((level) => (
                      <tr key={level}>
                        <th>{level}th</th>
                        {historicalPercentiles.map((bucket) => (
                          <td key={`${bucket.order}-${level}`}>
                            {formatPercentileValue(bucket.values[level] ?? null)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="percentile-calculator">
                  <div className="percentile-calculator-input">
                    <label htmlFor="percentile-input">Percentile rank input</label>
                    <input
                      id="percentile-input"
                      type="text"
                      inputMode="decimal"
                      placeholder="Enter a value"
                      value={percentileInput}
                      onChange={(event) => setPercentileInput(event.target.value)}
                    />
                  </div>
                  {[2, 3, 4, 5].map((order) => (
                    <div key={order} className="percentile-calculator-output">
                      <span>
                        Δ<sup>{order}</sup>Q
                      </span>
                      <strong>
                        {formatPercentileRank(historicalPercentileRanks[order] ?? null)}
                      </strong>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <p className="notice">
              Note: the percentile table and calculator can diverge when the historical window is
              short, since rounding and interpolation differences become more noticeable.
            </p>
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
