from __future__ import annotations

import io
import uuid
from dataclasses import dataclass
from pathlib import Path
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

INPUT_FILES: Dict[str, pd.DataFrame] = {}
INPUT_FILE_COLUMNS: Dict[str, List[str]] = {}
INPUT_FILE_SERIES: Dict[str, List[str]] = {}

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
    series: List[str]
    columns: List[str]


class InputFilesResponse(BaseModel):
    files: List[InputFileMetadata]
    series_names: List[str]


class PlotRequest(BaseModel):
    series_name: str
    files: List[str]
    start_label: Optional[str] = None
    end_label: Optional[str] = None


class InputFileUploadResponse(BaseModel):
    file: InputFileMetadata


class InputFileEditRequest(BaseModel):
    file_id: str
    series_name: str
    label: str
    value: float


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


def _parse_input_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty or "Name" not in df.columns:
        raise HTTPException(status_code=400, detail="Input file must include a Name column")
    parsed = df.set_index("Name")
    parsed.columns = [str(col) for col in parsed.columns]
    return parsed


def _load_input_files() -> None:
    INPUT_FILES.clear()
    INPUT_FILE_COLUMNS.clear()
    INPUT_FILE_SERIES.clear()
    if not TEST_DATA_DIR.exists():
        return
    for path in sorted(TEST_DATA_DIR.glob("*.csv")):
        df = pd.read_csv(path)
        try:
            parsed = _parse_input_dataframe(df)
        except HTTPException:
            continue
        INPUT_FILES[path.name] = parsed
        INPUT_FILE_COLUMNS[path.name] = parsed.columns.tolist()
        INPUT_FILE_SERIES[path.name] = parsed.index.astype(str).tolist()


def _get_series_values(df: pd.DataFrame, series_name: str, columns: List[str]) -> List[float | None]:
    if series_name not in df.index:
        raise HTTPException(status_code=400, detail=f"Unknown series name: {series_name}")
    row = df.loc[series_name].reindex(columns)
    values: List[float | None] = []
    for value in row.tolist():
        if pd.isna(value):
            values.append(None)
        else:
            values.append(float(value))
    return values


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
        metadata = InputFileMetadata(
            id=file_id,
            name=file_id,
            series=INPUT_FILE_SERIES.get(file_id, []),
            columns=INPUT_FILE_COLUMNS.get(file_id, []),
        )
        files.append(metadata)
        series_names.update(metadata.series)
    return InputFilesResponse(files=files, series_names=sorted(series_names))


@app.post("/api/plot-series")
def plot_series(request: PlotRequest) -> Dict[str, Any]:
    if not request.files:
        raise HTTPException(status_code=400, detail="Select at least one file to plot")
    if len(request.files) > 2:
        raise HTTPException(status_code=400, detail="Select up to two files to plot")

    missing = [file_id for file_id in request.files if file_id not in INPUT_FILES]
    if missing:
        raise HTTPException(status_code=404, detail=f"Unknown files: {', '.join(missing)}")

    primary_file = request.files[0]
    columns = INPUT_FILE_COLUMNS.get(primary_file, [])
    if not columns:
        raise HTTPException(status_code=400, detail="No columns available for selected file")
    columns = _slice_columns(columns, request.start_label, request.end_label)

    series_payload = []
    for file_id in request.files:
        df = INPUT_FILES[file_id]
        values = _get_series_values(df, request.series_name, columns)
        series_payload.append({"file": file_id, "values": values})

    return {"labels": columns, "series": series_payload}


@app.post("/api/input-files/upload", response_model=InputFileUploadResponse)
async def upload_input_file(file: UploadFile = File(...)) -> InputFileUploadResponse:
    content = await file.read()
    filename = file.filename or "uploaded.csv"
    try:
        if filename.endswith(".xlsx"):
            df = pd.read_excel(io.BytesIO(content))
        else:
            df = pd.read_csv(io.BytesIO(content))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {exc}") from exc

    parsed = _parse_input_dataframe(df)
    file_id = filename
    if file_id in INPUT_FILES:
        file_id = f"{Path(filename).stem}-{uuid.uuid4().hex[:8]}{Path(filename).suffix}"
    INPUT_FILES[file_id] = parsed
    INPUT_FILE_COLUMNS[file_id] = parsed.columns.tolist()
    INPUT_FILE_SERIES[file_id] = parsed.index.astype(str).tolist()
    metadata = InputFileMetadata(
        id=file_id,
        name=file_id,
        series=INPUT_FILE_SERIES[file_id],
        columns=INPUT_FILE_COLUMNS[file_id],
    )
    return InputFileUploadResponse(file=metadata)


@app.post("/api/input-files/edit")
def edit_input_file(request: InputFileEditRequest) -> Dict[str, Any]:
    df = INPUT_FILES.get(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="Input file not found")
    if request.series_name not in df.index:
        raise HTTPException(status_code=400, detail="Unknown series name")
    if request.label not in df.columns:
        raise HTTPException(status_code=400, detail="Unknown label")
    df.at[request.series_name, request.label] = request.value
    return {"status": "ok"}


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
