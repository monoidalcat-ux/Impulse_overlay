from __future__ import annotations

import io
import uuid
from dataclasses import dataclass
from pathlib import Path
import re
from typing import Any, Dict, List, Optional

import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@dataclass
class Dataset:
    df: pd.DataFrame
    filename: str
    date_column: str
    numeric_columns: List[str]


DATASETS: Dict[str, Dataset] = {}

INPUT_FILES: Dict[str, Dict[str, pd.DataFrame]] = {}
INPUT_FILE_COLUMNS: Dict[str, Dict[str, List[str]]] = {}
INPUT_FILE_SERIES: Dict[str, Dict[str, List[str]]] = {}
INPUT_FILE_FORMAT: Dict[str, str] = {}
INPUT_FILE_METADATA: Dict[str, Dict[str, pd.DataFrame]] = {}
INPUT_FILE_SHEETS: Dict[str, List[str]] = {}
NAME_LIST: Optional[List[str]] = None

TEST_DATA_DIR = Path(__file__).resolve().parents[1] / "test"


class SeriesRequest(BaseModel):
    date_column: str
    series: List[str]
    transform: str = Field("raw", pattern="^(raw|monthly_change|quarterly_change)$")
    start_date: Optional[str] = None
    end_date: Optional[str] = None


class EditItem(BaseModel):
    date: str
    column: str
    value: float


class EditRequest(BaseModel):
    edits: List[EditItem]


class InputFileMetadata(BaseModel):
    id: str
    name: str
    sheets: List[str]
    series_by_sheet: Dict[str, List[str]]
    columns_by_sheet: Dict[str, List[str]]


class InputFilesResponse(BaseModel):
    files: List[InputFileMetadata]
    series_names: List[str]


class PlotRequest(BaseModel):
    series_name: str
    files: List[str]
    start_label: Optional[str] = None
    end_label: Optional[str] = None
    sheet_name: Optional[str] = None


class InputFilesUploadResponse(BaseModel):
    files: List[InputFileMetadata]


class NameListResponse(BaseModel):
    active: bool
    names: List[str]


class InputFileEditRequest(BaseModel):
    file_id: str
    series_name: str
    label: str
    value: float
    sheet_name: Optional[str] = None


class DeleteInputFileResponse(BaseModel):
    deleted: bool


def _infer_date_column(df: pd.DataFrame) -> str:
    best_column = df.columns[0]
    best_score = -1.0
    for column in df.columns:
        parsed = pd.to_datetime(df[column], errors="coerce", infer_datetime_format=True)
        score = parsed.notna().mean()
        if score > best_score:
            best_score = score
            best_column = column
    return best_column


TIME_COLUMN_PATTERN = re.compile(r"^\d{4}\.\d+$")

DEFAULT_SHEET = "Quarterly"


def _parse_input_dataframe(df: pd.DataFrame) -> tuple[pd.DataFrame, List[str], pd.DataFrame]:
    if df.empty:
        raise HTTPException(status_code=400, detail="Input file must include at least one row")
    normalized = df.copy()
    normalized.columns = [str(col).strip() for col in normalized.columns]
    if "Mnemonic" not in normalized.columns:
        raise HTTPException(status_code=400, detail="Input file must include a Mnemonic column")
    time_columns = [
        column
        for column in normalized.columns
        if column != "Mnemonic" and TIME_COLUMN_PATTERN.match(column)
    ]
    if not time_columns:
        raise HTTPException(
            status_code=400,
            detail="Input file must include timestamp columns like 2022.1",
        )
    metadata_columns = [
        column
        for column in normalized.columns
        if column not in time_columns and column != "Mnemonic"
    ]
    parsed = normalized.set_index("Mnemonic")
    metadata_df = (
        parsed[metadata_columns].copy() if metadata_columns else pd.DataFrame(index=parsed.index)
    )
    return parsed, time_columns, metadata_df


def _load_input_files() -> None:
    INPUT_FILES.clear()
    INPUT_FILE_COLUMNS.clear()
    INPUT_FILE_SERIES.clear()
    INPUT_FILE_FORMAT.clear()
    INPUT_FILE_METADATA.clear()
    INPUT_FILE_SHEETS.clear()
    global NAME_LIST
    NAME_LIST = None
    if not TEST_DATA_DIR.exists():
        return
    for path in sorted(list(TEST_DATA_DIR.glob("*.csv")) + list(TEST_DATA_DIR.glob("*.xlsx"))):
        if path.suffix.lower() == ".xlsx":
            try:
                sheets = pd.read_excel(path, sheet_name=None)
            except Exception:
                continue
            parsed_sheets = _parse_excel_sheets(sheets)
            if not parsed_sheets:
                continue
            _register_input_file(path.name, parsed_sheets, "xlsx")
        else:
            df = pd.read_csv(path)
            try:
                parsed, time_columns, metadata_df = _parse_input_dataframe(df)
            except HTTPException:
                continue
            _register_input_file(
                path.name,
                {DEFAULT_SHEET: (parsed, time_columns, metadata_df)},
                "csv",
            )


def _parse_excel_sheets(
    sheets: Dict[str, pd.DataFrame],
) -> Dict[str, tuple[pd.DataFrame, List[str], pd.DataFrame]]:
    if DEFAULT_SHEET not in sheets:
        return {}
    try:
        return {DEFAULT_SHEET: _parse_input_dataframe(sheets[DEFAULT_SHEET])}
    except HTTPException:
        return {}


def _register_input_file(
    file_id: str,
    parsed_sheets: Dict[str, tuple[pd.DataFrame, List[str], pd.DataFrame]],
    file_format: str,
) -> None:
    INPUT_FILES[file_id] = {}
    INPUT_FILE_COLUMNS[file_id] = {}
    INPUT_FILE_SERIES[file_id] = {}
    INPUT_FILE_METADATA[file_id] = {}
    for sheet_name, (parsed, time_columns, metadata_df) in parsed_sheets.items():
        INPUT_FILES[file_id][sheet_name] = parsed
        INPUT_FILE_COLUMNS[file_id][sheet_name] = time_columns
        INPUT_FILE_SERIES[file_id][sheet_name] = parsed.index.astype(str).tolist()
        INPUT_FILE_METADATA[file_id][sheet_name] = metadata_df
    INPUT_FILE_FORMAT[file_id] = file_format
    INPUT_FILE_SHEETS[file_id] = sorted(parsed_sheets.keys())


def _get_series_values(df: pd.DataFrame, series_name: str, columns: List[str]) -> List[float | None]:
    if series_name not in df.index:
        return [None for _ in columns]
    row = df.loc[series_name].reindex(columns)
    values: List[float | None] = []
    for value in row.tolist():
        if pd.isna(value):
            values.append(None)
        else:
            values.append(float(value))
    return values


def _get_series_columns(
    df: pd.DataFrame, series_name: str, columns: List[str]
) -> List[str]:
    if series_name not in df.index:
        return []
    row = df.loc[series_name].reindex(columns)
    return [label for label, value in row.items() if pd.notna(value)]


def _get_series_metadata(
    series_name: str, file_ids: List[str], sheet_name: str
) -> Dict[str, str]:
    for file_id in file_ids:
        metadata_df = INPUT_FILE_METADATA.get(file_id, {}).get(sheet_name)
        if metadata_df is None or metadata_df.empty:
            continue
        if series_name not in metadata_df.index:
            continue
        row = metadata_df.loc[series_name]
        if isinstance(row, pd.DataFrame):
            row = row.iloc[0]
        metadata: Dict[str, str] = {}
        for column in metadata_df.columns:
            value = row[column]
            if pd.isna(value):
                continue
            text = str(value).strip()
            if text:
                metadata[column] = text
        if metadata:
            return metadata
    return {}


def _get_series_scenario(file_id: str, series_name: str, sheet_name: str) -> Optional[str]:
    metadata_df = INPUT_FILE_METADATA.get(file_id, {}).get(sheet_name)
    if metadata_df is None or metadata_df.empty or "Scenario" not in metadata_df.columns:
        return None
    if series_name not in metadata_df.index:
        return None
    row = metadata_df.loc[series_name]
    if isinstance(row, pd.DataFrame):
        row = row.iloc[0]
    value = row.get("Scenario")
    if pd.isna(value):
        return None
    scenario = str(value).strip()
    return scenario or None


def _slice_columns(
    columns: List[str], start_label: Optional[str], end_label: Optional[str]
) -> List[str]:
    if not columns:
        return columns
    start_idx = 0
    end_idx = len(columns) - 1
    if start_label:
        if start_label not in columns:
            raise HTTPException(status_code=400, detail=f"Unknown start label: {start_label}")
        start_idx = columns.index(start_label)
    if end_label:
        if end_label not in columns:
            raise HTTPException(status_code=400, detail=f"Unknown end label: {end_label}")
        end_idx = columns.index(end_label)
    if start_idx > end_idx:
        start_idx, end_idx = end_idx, start_idx
    return columns[start_idx : end_idx + 1]


def _merge_columns(base: List[str], additions: List[str]) -> List[str]:
    merged = list(base)
    seen = set(base)
    for label in additions:
        if label not in seen:
            merged.append(label)
            seen.add(label)
    return merged


def _prepare_preview(df: pd.DataFrame, limit: int = 20) -> List[Dict[str, Any]]:
    preview = df.head(limit).copy()
    for column in preview.columns:
        if pd.api.types.is_datetime64_any_dtype(preview[column]):
            preview[column] = preview[column].dt.strftime("%Y-%m-%d")
    return preview.to_dict(orient="records")


def _apply_transform(df: pd.DataFrame, date_column: str, series: List[str], transform: str) -> pd.DataFrame:
    working = df[[date_column] + series].copy()
    working[date_column] = pd.to_datetime(working[date_column], errors="coerce")
    working = working.dropna(subset=[date_column])
    working = working.sort_values(date_column)

    if transform == "raw":
        return working

    working = working.set_index(date_column)
    if transform == "monthly_change":
        resampled = working.resample("M").mean()
    else:
        resampled = working.resample("Q").mean()
    changed = resampled.diff().dropna().reset_index()
    return changed


def _serialize_series(df: pd.DataFrame, date_column: str, series: List[str]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "dates": df[date_column].dt.strftime("%Y-%m-%d").tolist()
    }
    for name in series:
        payload[name] = df[name].tolist()
    return payload


@app.get("/api/input-files", response_model=InputFilesResponse)
def list_input_files() -> InputFilesResponse:
    files: List[InputFileMetadata] = []
    series_names: set[str] = set()
    for file_id in sorted(INPUT_FILES.keys()):
        series_by_sheet = INPUT_FILE_SERIES.get(file_id, {})
        columns_by_sheet = INPUT_FILE_COLUMNS.get(file_id, {})
        metadata = InputFileMetadata(
            id=file_id,
            name=file_id,
            sheets=INPUT_FILE_SHEETS.get(file_id, [DEFAULT_SHEET]),
            series_by_sheet=series_by_sheet,
            columns_by_sheet=columns_by_sheet,
        )
        files.append(metadata)
        for series in series_by_sheet.values():
            series_names.update(series)
    return InputFilesResponse(files=files, series_names=sorted(series_names))


@app.post("/api/plot-series")
def plot_series(request: PlotRequest) -> Dict[str, Any]:
    if not request.files:
        raise HTTPException(status_code=400, detail="Select at least one file to plot")
    missing = [file_id for file_id in request.files if file_id not in INPUT_FILES]
    if missing:
        raise HTTPException(status_code=404, detail=f"Unknown files: {', '.join(missing)}")

    sheet_name = request.sheet_name or DEFAULT_SHEET
    columns: List[str] = []
    for file_id in request.files:
        df = INPUT_FILES.get(file_id, {}).get(sheet_name)
        if df is None:
            continue
        file_columns = INPUT_FILE_COLUMNS.get(file_id, {}).get(sheet_name, [])
        series_columns = _get_series_columns(df, request.series_name, file_columns)
        columns = _merge_columns(columns, series_columns)
    if not columns:
        raise HTTPException(
            status_code=400,
            detail="No columns available for the selected series",
        )
    columns = _slice_columns(columns, request.start_label, request.end_label)

    series_payload = []
    for file_id in request.files:
        df = INPUT_FILES[file_id].get(sheet_name)
        if df is None:
            raise HTTPException(
                status_code=400,
                detail=f"Sheet {sheet_name} not found for {file_id}",
            )
        values = _get_series_values(df, request.series_name, columns)
        scenario = _get_series_scenario(file_id, request.series_name, sheet_name)
        series_payload.append({"file": file_id, "values": values, "scenario": scenario})
    metadata = _get_series_metadata(request.series_name, request.files, sheet_name)

    return {"labels": columns, "series": series_payload, "metadata": metadata}


async def _store_uploaded_file(file: UploadFile) -> InputFileMetadata:
    content = await file.read()
    filename = file.filename or "uploaded.csv"
    file_format = "xlsx" if filename.endswith(".xlsx") else "csv"
    try:
        if filename.endswith(".xlsx"):
            sheets = pd.read_excel(io.BytesIO(content), sheet_name=None)
        else:
            df = pd.read_csv(io.BytesIO(content))
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to parse {filename}: {exc}",
        ) from exc

    file_id = filename
    if file_id in INPUT_FILES:
        file_id = f"{Path(filename).stem}-{uuid.uuid4().hex[:8]}{Path(filename).suffix}"
    if file_format == "xlsx":
        parsed_sheets = _parse_excel_sheets(sheets)
        if not parsed_sheets:
            raise HTTPException(
                status_code=400,
                detail="Excel file must include a Quarterly sheet",
            )
        _register_input_file(file_id, parsed_sheets, file_format)
    else:
        parsed, time_columns, metadata_df = _parse_input_dataframe(df)
        _register_input_file(
            file_id,
            {DEFAULT_SHEET: (parsed, time_columns, metadata_df)},
            file_format,
        )
    return InputFileMetadata(
        id=file_id,
        name=file_id,
        sheets=INPUT_FILE_SHEETS[file_id],
        series_by_sheet=INPUT_FILE_SERIES[file_id],
        columns_by_sheet=INPUT_FILE_COLUMNS[file_id],
    )


def _parse_name_list(data: bytes, filename: str) -> List[str]:
    if not filename.endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Name list must be an Excel .xlsx file")
    try:
        sheets = pd.read_excel(io.BytesIO(data), sheet_name=None)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse {filename}: {exc}") from exc
    if len(sheets) != 1:
        raise HTTPException(status_code=400, detail="Name list must contain exactly one sheet")
    df = next(iter(sheets.values()))
    df.columns = [str(col).strip() for col in df.columns]
    if "Mnemonic" not in df.columns:
        raise HTTPException(status_code=400, detail="Name list must include a Mnemonic column")
    names = (
        df["Mnemonic"]
        .dropna()
        .astype(str)
        .map(str.strip)
    )
    unique_names = sorted({name for name in names if name})
    return unique_names


@app.post("/api/input-files/upload", response_model=InputFilesUploadResponse)
async def upload_input_file(
    files: List[UploadFile] = File(...),
) -> InputFilesUploadResponse:
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")
    uploaded_files = []
    for file in files:
        uploaded_files.append(await _store_uploaded_file(file))
    return InputFilesUploadResponse(files=uploaded_files)


@app.get("/api/name-list", response_model=NameListResponse)
def get_name_list() -> NameListResponse:
    if not NAME_LIST:
        return NameListResponse(active=False, names=[])
    return NameListResponse(active=True, names=NAME_LIST)


@app.post("/api/name-list/upload", response_model=NameListResponse)
async def upload_name_list(file: UploadFile = File(...)) -> NameListResponse:
    content = await file.read()
    names = _parse_name_list(content, file.filename or "name-list.xlsx")
    global NAME_LIST
    NAME_LIST = names
    return NameListResponse(active=True, names=names)


@app.post("/api/input-files/edit")
def edit_input_file(request: InputFileEditRequest) -> Dict[str, Any]:
    sheet_name = request.sheet_name or DEFAULT_SHEET
    df = INPUT_FILES.get(request.file_id, {}).get(sheet_name)
    if df is None:
        raise HTTPException(status_code=404, detail="Input file not found")
    if request.series_name not in df.index:
        raise HTTPException(status_code=400, detail="Unknown series name")
    time_columns = INPUT_FILE_COLUMNS.get(request.file_id, {}).get(sheet_name, [])
    if request.label not in time_columns:
        raise HTTPException(status_code=400, detail="Unknown label")
    df.at[request.series_name, request.label] = request.value
    return {"status": "ok"}


@app.delete("/api/input-files/{file_id}", response_model=DeleteInputFileResponse)
def delete_input_file(file_id: str) -> DeleteInputFileResponse:
    if file_id not in INPUT_FILES:
        raise HTTPException(status_code=404, detail="Input file not found")
    INPUT_FILES.pop(file_id, None)
    INPUT_FILE_COLUMNS.pop(file_id, None)
    INPUT_FILE_SERIES.pop(file_id, None)
    INPUT_FILE_FORMAT.pop(file_id, None)
    INPUT_FILE_METADATA.pop(file_id, None)
    INPUT_FILE_SHEETS.pop(file_id, None)
    return DeleteInputFileResponse(deleted=True)


@app.get("/api/input-files/{file_id}/download")
def download_input_file(file_id: str) -> StreamingResponse:
    sheets = INPUT_FILES.get(file_id)
    if sheets is None:
        raise HTTPException(status_code=404, detail="Input file not found")
    file_format = INPUT_FILE_FORMAT.get(file_id, "csv")
    if file_format == "xlsx":
        buffer = io.BytesIO()
        with pd.ExcelWriter(buffer) as writer:
            for sheet_name, df in sheets.items():
                df.reset_index().to_excel(writer, sheet_name=sheet_name, index=False)
        buffer.seek(0)
        headers = {"Content-Disposition": f"attachment; filename={file_id}"}
        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers,
        )
    df = sheets.get(DEFAULT_SHEET)
    if df is None:
        raise HTTPException(status_code=400, detail="No Quarterly data found for CSV export")
    export_df = df.reset_index()
    buffer = io.StringIO()
    export_df.to_csv(buffer, index=False)
    headers = {"Content-Disposition": f"attachment; filename={file_id}"}
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers=headers,
    )


_load_input_files()


@app.post("/api/upload")
async def upload_dataset(file: UploadFile = File(...)) -> Dict[str, Any]:
    content = await file.read()
    filename = file.filename or "dataset"
    try:
        if filename.endswith(".xlsx"):
            df = pd.read_excel(io.BytesIO(content))
        else:
            df = pd.read_csv(io.BytesIO(content))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {exc}") from exc

    if df.empty:
        raise HTTPException(status_code=400, detail="Uploaded file contains no data")

    date_column = _infer_date_column(df)
    df[date_column] = pd.to_datetime(df[date_column], errors="coerce")
    numeric_columns = df.select_dtypes(include="number").columns.tolist()
    dataset_id = str(uuid.uuid4())
    DATASETS[dataset_id] = Dataset(
        df=df,
        filename=filename,
        date_column=date_column,
        numeric_columns=numeric_columns,
    )
    min_date = df[date_column].min()
    max_date = df[date_column].max()
    return {
        "dataset_id": dataset_id,
        "columns": df.columns.tolist(),
        "numeric_columns": numeric_columns,
        "date_column": date_column,
        "preview": _prepare_preview(df),
        "min_date": min_date.strftime("%Y-%m-%d") if pd.notna(min_date) else None,
        "max_date": max_date.strftime("%Y-%m-%d") if pd.notna(max_date) else None,
    }


@app.get("/api/datasets/{dataset_id}")
def get_metadata(dataset_id: str) -> Dict[str, Any]:
    dataset = DATASETS.get(dataset_id)
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    df = dataset.df
    min_date = df[dataset.date_column].min()
    max_date = df[dataset.date_column].max()
    return {
        "dataset_id": dataset_id,
        "columns": df.columns.tolist(),
        "numeric_columns": dataset.numeric_columns,
        "date_column": dataset.date_column,
        "preview": _prepare_preview(df),
        "min_date": min_date.strftime("%Y-%m-%d") if pd.notna(min_date) else None,
        "max_date": max_date.strftime("%Y-%m-%d") if pd.notna(max_date) else None,
    }


@app.post("/api/datasets/{dataset_id}/series")
def get_series(dataset_id: str, request: SeriesRequest) -> Dict[str, Any]:
    dataset = DATASETS.get(dataset_id)
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    df = dataset.df
    if request.date_column not in df.columns:
        raise HTTPException(status_code=400, detail="Invalid date column")
    for column in request.series:
        if column not in df.columns:
            raise HTTPException(status_code=400, detail=f"Unknown series column: {column}")

    transformed = _apply_transform(df, request.date_column, request.series, request.transform)
    if request.start_date:
        start = pd.to_datetime(request.start_date)
        transformed = transformed[transformed[request.date_column] >= start]
    if request.end_date:
        end = pd.to_datetime(request.end_date)
        transformed = transformed[transformed[request.date_column] <= end]

    transformed = transformed.dropna(subset=request.series)
    return {
        "data": _serialize_series(transformed, request.date_column, request.series),
        "table": _prepare_preview(transformed, limit=30),
    }


@app.post("/api/datasets/{dataset_id}/edit")
def apply_edits(dataset_id: str, request: EditRequest) -> Dict[str, Any]:
    dataset = DATASETS.get(dataset_id)
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    df = dataset.df
    date_column = dataset.date_column
    df[date_column] = pd.to_datetime(df[date_column], errors="coerce")

    for edit in request.edits:
        if edit.column not in df.columns:
            raise HTTPException(status_code=400, detail=f"Unknown column {edit.column}")
        target_date = pd.to_datetime(edit.date)
        mask = df[date_column] == target_date
        if not mask.any():
            raise HTTPException(status_code=400, detail=f"No row found for {edit.date}")
        df.loc[mask, edit.column] = edit.value

    return {"status": "ok"}


@app.get("/api/datasets/{dataset_id}/export")
def export_dataset(dataset_id: str, format: str = "csv") -> StreamingResponse:
    dataset = DATASETS.get(dataset_id)
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    df = dataset.df
    if format == "xlsx":
        buffer = io.BytesIO()
        df.to_excel(buffer, index=False)
        buffer.seek(0)
        headers = {
            "Content-Disposition": f"attachment; filename={dataset.filename}.xlsx"
        }
        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers,
        )

    buffer = io.StringIO()
    df.to_csv(buffer, index=False)
    headers = {"Content-Disposition": f"attachment; filename={dataset.filename}.csv"}
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers=headers,
    )
