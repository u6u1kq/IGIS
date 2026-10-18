// SPDX-License-Identifier: Apache-2.0

/**
 * V0.93.2 独立对照：克里金、汇水、剖面、填挖方、权重、句柄、边界。
 * 只读产品代码。测试数据在系统临时目录，结束时删除。
 * 运行：npx --yes tsx --tsconfig tsconfig.json apps/cli/src/v0932-grok-check.ts
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cwd, env as nodeEnv, platform } from "node:process";
import { createProcessBackend, ExternalCapabilityBoundary, managedPythonPath } from "@igis/external-gateway";
import { projectForModel } from "../../../packages/ai-translation/src/allowlist.js";
import { createSpatialAwareAdapter } from "../../../packages/spatial-ops/src/adapter.js";
import { parseProModel, ProModelError } from "../../../packages/spatial-ops/src/pro-model.js";
import { openSpatialStack, rasterHandle } from "../../../packages/spatial-ops/src/service.js";
import type { MapFeature } from "../../../packages/spatial-ops/src/types.js";

const REPO_ROOT = resolve(cwd());
const failures: string[] = [];

function check(condition: unknown, label: string): void {
  const mark = condition ? "PASS" : "FAIL";
  console.log(`${mark} ${label}`);
  if (!condition) failures.push(label);
}

function run(command: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: Record<string, string | undefined>; readonly shell?: boolean }): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result: { readonly code: number; readonly stdout: string; readonly stderr: string }): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    const child = spawn(command, args, { cwd: options?.cwd, env: options?.env ?? nodeEnv, shell: options?.shell === true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += typeof chunk === "string" ? chunk : String(chunk); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += typeof chunk === "string" ? chunk : String(chunk); });
    child.on("error", (error) => finish({ code: 1, stdout, stderr: `${stderr}\n${error.message}` }));
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

const PYTHON = String.raw`
# -*- coding: utf-8 -*-
import io, json, math, os, sys, time, contextlib, importlib.util
lib = os.path.join(os.path.dirname(sys.executable), "Library", "bin")
if os.path.isdir(lib):
    os.environ["PATH"] = lib + os.pathsep + os.environ.get("PATH", "")
os.environ["PYTHONIOENCODING"] = "utf-8"

bridge_path, train_path, work, raster_dir, other_dir, report_path = sys.argv[1:7]
os.makedirs(work, exist_ok=True)
os.makedirs(raster_dir, exist_ok=True)
os.makedirs(other_dir, exist_ok=True)
os.environ["IGIS_BACKEND_ROOT"] = work

spec = importlib.util.spec_from_file_location("igis_bridge", bridge_path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
tspec = importlib.util.spec_from_file_location("igis_train", train_path)
train = importlib.util.module_from_spec(tspec)
tspec.loader.exec_module(train)

import numpy
from osgeo import gdal, osr
gdal.UseExceptions()

checks = []
observations = {}

def log(text):
    sys.stderr.write(text + "\n")
    sys.stderr.flush()

def save():
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump({"checks": checks, "observations": observations}, handle, ensure_ascii=False, indent=2)

def expect(name, ok, detail):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})
    log(("PASS " if ok else "FAIL ") + name)

def expect_close(name, actual, expected, tol):
    good = actual is not None and math.isfinite(actual) and abs(actual - expected) <= tol
    expect(name, good, "actual=%s expected=%s tol=%s" % (actual, expected, tol))

def clip(text):
    text = "" if text is None else str(text)
    return text if len(text) <= 400 else text[:400]

def capture(fn):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            value = fn()
        except SystemExit:
            value = None
    text = buf.getvalue().strip()
    parsed = None
    if text:
        try:
            parsed = json.loads(text.splitlines()[-1])
        except json.JSONDecodeError:
            parsed = {"ok": False, "message": text[-400:]}
    return value, parsed

def rel(path):
    return os.path.relpath(path, work).replace("\\", "/")

def write_tif(path, array, transform, epsg=None, unit=None, nodata=-9999.0):
    height, width = array.shape
    dataset = gdal.GetDriverByName("GTiff").Create(path, width, height, 1, gdal.GDT_Float64)
    dataset.SetGeoTransform([float(v) for v in transform])
    if epsg is not None or unit is not None:
        srs = osr.SpatialReference()
        if epsg is not None:
            srs.ImportFromEPSG(int(epsg))
        else:
            srs.SetLocalCS("local")
            srs.SetLinearUnits("unit", float(unit))
        dataset.SetProjection(srs.ExportToWkt())
    band = dataset.GetRasterBand(1)
    band.SetNoDataValue(nodata)
    band.WriteArray(numpy.where(numpy.isfinite(array), array, nodata))
    dataset.FlushCache()
    dataset = None

def write_geojson(path, features):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": features}, handle)

def point_feature(x, y, value=None):
    props = {} if value is None else {"v": float(value)}
    return {"type": "Feature", "properties": props, "geometry": {"type": "Point", "coordinates": [float(x), float(y)]}}

def line_feature(coords, kind="LineString"):
    return {"type": "Feature", "properties": {}, "geometry": {"type": kind, "coordinates": coords}}

def request(resources, parameters, hint="t"):
    return {"capability": "x", "inputResources": [rel(p) for p in resources], "parameters": parameters, "outputHint": hint}

def invoke(fn, req):
    _value, parsed = capture(lambda: fn(req))
    return parsed or {"ok": False, "message": "no output"}

def read_band(resource):
    dataset = gdal.Open(os.path.join(work, resource))
    array = dataset.ReadAsArray().astype("float64")
    dataset = None
    return array

def shape_of(model, h, a):
    t = h / a
    if model == "spherical":
        return numpy.where(t < 1.0, 1.5 * t - 0.5 * t ** 3, 1.0)
    if model == "exponential":
        return 1.0 - numpy.exp(-3.0 * t)
    if model == "gaussian":
        return 1.0 - numpy.exp(-3.0 * t * t)
    raise ValueError(model)

def covariance(h, sill, nugget, a, model):
    structured = sill * (1.0 - nugget)
    return numpy.where(h > 0, structured * (1.0 - shape_of(model, h, a)), sill)

def global_ok(xy, z, targets, sill, nugget, a, model, regularize):
    count = len(z)
    distance = numpy.sqrt(((xy[:, None, :] - xy[None, :, :]) ** 2).sum(-1))
    system_c = covariance(distance, sill, nugget, a, model)
    if regularize:
        system_c = system_c + numpy.eye(count) * sill * 1e-9
    matrix = numpy.ones((count + 1, count + 1))
    matrix[:count, :count] = system_c
    matrix[count, count] = 0.0
    predictions = numpy.empty(len(targets))
    variances = numpy.empty(len(targets))
    weight_error = 0.0
    for index, target in enumerate(targets):
        gap = numpy.sqrt(((xy - target) ** 2).sum(-1))
        right_c = covariance(gap, sill, nugget, a, model)
        right = numpy.ones(count + 1)
        right[:count] = right_c
        solution = numpy.linalg.solve(matrix, right)
        weights = solution[:count]
        weight_error = max(weight_error, abs(float(weights.sum()) - 1.0))
        predictions[index] = float(weights @ z)
        variances[index] = max(float(sill - weights @ right_c - solution[count]), 0.0)
    return predictions, variances, weight_error

def leave_one_out(xy, z, sill, nugget, a, model):
    predictions = numpy.empty(len(z))
    variances = numpy.empty(len(z))
    for index in range(len(z)):
        keep = numpy.ones(len(z), dtype=bool)
        keep[index] = False
        pred, var, _error = global_ok(xy[keep], z[keep], xy[index:index + 1], sill, nugget, a, model, True)
        predictions[index] = pred[0]
        variances[index] = var[0]
    return predictions, variances

def conservation(routing, valid):
    accumulation = routing["accumulation"]
    receiver = numpy.array(routing["receiver"])
    stride = routing["stride"]
    rows, cols = numpy.indices(accumulation.shape)
    padded = (rows + 1) * stride + (cols + 1)
    terminals = receiver[padded] < 0
    return float(accumulation[terminals].sum()), int(valid.sum()), int(terminals.sum())

def strict_flow(dem, valid, step):
    filled, seeds = bridge.priority_flood(dem, valid)
    padded = numpy.zeros(filled.shape, dtype=bool)
    padded[1:-1, 1:-1] = valid
    receiver = bridge.d8_receivers(filled, padded, step, step)
    stride = filled.shape[1]
    rows, cols = numpy.indices(valid.shape)
    index = (rows + 1) * stride + (cols + 1)
    flat_receiver = receiver.ravel()
    target = flat_receiver[index]
    flowing = valid & (target >= 0)
    source_value = filled.ravel()[index]
    target_value = numpy.ones(valid.shape)
    target_value[flowing] = filled.ravel()[target[flowing]]
    not_lower = flowing & ~(source_value > target_value)
    target_row, target_col = numpy.divmod(numpy.maximum(target, 0), stride)
    source_row, source_col = rows + 1, cols + 1
    far = flowing & (numpy.maximum(numpy.abs(target_row - source_row), numpy.abs(target_col - source_col)) != 1)
    nonseed = valid & ~seeds[1:-1, 1:-1]
    sink = valid & (target < 0)
    return {
        "notLower": int(not_lower.sum()),
        "wrapped": int(far.sum()),
        "nonseedSinks": int((nonseed & sink).sum()),
        "seedSinks": int((~nonseed & sink & valid).sum()),
    }

def write_service():
    rows, cols = numpy.mgrid[0:40, 0:40]
    transform = [0, 50, 0, 2000, 0, -50]
    dem = (cols * 50 + 25) / 100.0
    after = dem.copy()
    after[2:6, 2:6] += 2
    after[10:14, 20:24] -= 1
    write_tif(os.path.join(raster_dir, "dem.tif"), dem, transform, epsg=3857)
    write_tif(os.path.join(raster_dir, "after.tif"), after, transform, epsg=3857)
    shifted = [50, 50, 0, 2000, 0, -50]
    write_tif(os.path.join(raster_dir, "after-shift.tif"), after, shifted, epsg=3857)
    write_tif(os.path.join(raster_dir, "after-32650.tif"), after, transform, epsg=32650)
    tiny = list(transform)
    tiny[0] = 1e-4
    write_tif(os.path.join(raster_dir, "after-tiny.tif"), after, tiny, epsg=3857)
    write_tif(os.path.join(raster_dir, "shared.tif"), numpy.full((10, 10), 10.0), transform, epsg=3857)
    write_tif(os.path.join(other_dir, "shared.tif"), numpy.full((10, 10), 99.0), transform, epsg=3857)
    write_tif(os.path.join(other_dir, "only-b.tif"), numpy.full((10, 10), 50.0), transform, epsg=3857)
    write_tif(os.path.join(raster_dir, "dem-nocrs.tif"), dem, transform, epsg=None)
    angle = math.radians(20)
    rotated = [0, 50 * math.cos(angle), 50 * math.sin(angle), 2000, 50 * math.sin(angle), -50 * math.cos(angle)]
    write_tif(os.path.join(raster_dir, "dem-rot.tif"), dem[:8, :8], rotated, epsg=3857)
    write_tif(os.path.join(raster_dir, "after-rot.tif"), after[:8, :8], rotated, epsg=3857)
    geo = numpy.arange(64, dtype="float64").reshape(8, 8)
    write_tif(os.path.join(raster_dir, "dem-geo.tif"), geo, [120, 0.01, 0, 32, 0, -0.01], epsg=4326)

def test_variogram():
    h = numpy.array([0.0, 1e-8, 0.2, 1.0])
    for model in ("spherical", "exponential", "gaussian"):
        mine = shape_of(model, h, 0.5)
        theirs = bridge.variogram_shape(model, h, 0.5)
        expect("shape " + model, float(numpy.max(numpy.abs(mine - theirs))) < 1e-12, float(numpy.max(numpy.abs(mine - theirs))))
    sill, nugget, a = 2.0, 0.25, 0.5
    jump = float(covariance(numpy.array([0.0]), sill, nugget, a, "spherical")[0] - covariance(numpy.array([1e-8]), sill, nugget, a, "spherical")[0])
    expect_close("nugget jump equals sill*nugget", jump, sill * nugget, 1e-6)
    lags = numpy.array([0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8])
    true_a, true_n, true_s = 0.4, 0.1, 1.7
    gammas = true_s * (true_n + (1.0 - true_n) * shape_of("spherical", lags, true_a))
    counts = numpy.full(len(lags), 20.0)
    got_a, got_n, got_s, misfit, _share = bridge.fit_variogram(lags, gammas, counts, "spherical", true_n, true_a, 0.0, 40)
    expect_close("closed-form sill", got_s, true_s, 1e-8)
    expect_close("grid recovers range", got_a, true_a, 1e-12)
    expect_close("grid recovers nugget", got_n, true_n, 1e-12)
    expect("exact curve misfit is 0", misfit < 1e-10, misfit)
    got_a, got_n, got_s, _m, _s = bridge.fit_variogram(lags, gammas, counts, "spherical", 0.5, 1.0, 10000.0, 20)
    expect_close("large prior keeps range", got_a, 1.0, 1e-12)
    expect_close("large prior keeps nugget", got_n, 0.5, 1e-12)
    zero = true_s * shape_of("gaussian", lags, true_a)
    _a, gn, _s, _m, _share = bridge.fit_variogram(lags, zero, counts, "gaussian", 0.0, true_a, 0.0, 40)
    expect_close("gaussian nugget floor", gn, 0.002, 1e-12)
    _a, sn, _s, _m, _share = bridge.fit_variogram(lags, true_s * shape_of("spherical", lags, true_a), counts, "spherical", 0.0, true_a, 0.0, 40)
    expect_close("spherical nugget can be 0", sn, 0.0, 1e-12)

def test_krige():
    rng = numpy.random.default_rng(7)
    sill, nugget, a, model = 1.3, 0.2, 0.35, "spherical"
    xy = rng.uniform(0.0, 1.0, (40, 2))
    z = numpy.sin(xy[:, 0] * 3.0) + numpy.cos(xy[:, 1] * 2.0)
    targets = numpy.vstack([rng.uniform(0.0, 1.0, (5, 2)), xy[:3]])
    mine, my_var, weight_error = global_ok(xy, z, targets, sill, nugget, a, model, True)
    bare, bare_var, _error = global_ok(xy, z, targets, sill, nugget, a, model, False)
    theirs, their_var = bridge.krige(xy, z, targets, 64, model, sill, nugget, a)
    diff = float(numpy.max(numpy.abs(mine - theirs)))
    vdiff = float(numpy.max(numpy.abs(my_var - their_var)))
    bare_diff = float(numpy.max(numpy.abs(bare - theirs)))
    observations["krigePredDiffReg"] = diff
    observations["krigeVarDiffReg"] = vdiff
    observations["krigePredDiffBare"] = bare_diff
    observations["weightSumError"] = weight_error
    expect("global weights sum to 1", weight_error < 1e-8, weight_error)
    expect("local n=40 matches global prediction", diff < 1e-6, diff)
    expect("local n=40 matches global variance", vdiff < 1e-6, vdiff)
    loo_mine, loo_my_var = leave_one_out(xy, z, sill, nugget, a, model)
    loo_theirs, loo_their_var = bridge.krige(xy, z, xy, 64, model, sill, nugget, a, self_index=numpy.arange(40))
    loo_diff = float(numpy.max(numpy.abs(loo_mine - loo_theirs)))
    loo_vdiff = float(numpy.max(numpy.abs(loo_my_var - loo_their_var)))
    observations["looPredDiff"] = loo_diff
    observations["looVarDiff"] = loo_vdiff
    expect("LOO matches independent leave-one-out", loo_diff < 1e-6 and loo_vdiff < 1e-6, "%s %s" % (loo_diff, loo_vdiff))
    at_data, _v = bridge.krige(xy, z, xy, 64, model, sill, nugget, a)
    loo_gap = float(numpy.max(numpy.abs(at_data - loo_theirs)))
    observations["looVersusInterpolate"] = loo_gap
    expect("LOO differs from prediction that keeps the point", loo_gap > 1e-3, loo_gap)
    xy64 = rng.uniform(0.0, 1.0, (64, 2))
    z64 = numpy.sin(xy64[:, 0] * 4.0)
    pred64, _ = bridge.krige(xy64, z64, xy64[:2], 64, model, sill, nugget, a)
    mine64, _var, _err = global_ok(xy64, z64, xy64[:2], sill, nugget, a, model, True)
    expect("n=64 prediction is global", float(numpy.max(numpy.abs(pred64 - mine64))) < 1e-6, float(numpy.max(numpy.abs(pred64 - mine64))))
    xy65 = rng.uniform(0.0, 1.0, (65, 2))
    z65 = numpy.sin(xy65[:, 0] * 4.0) + xy65[:, 1]
    real_solve = numpy.linalg.solve
    shapes = []
    def watch(matrix, right):
        shapes.append(tuple(matrix.shape))
        return real_solve(matrix, right)
    numpy.linalg.solve = watch
    try:
        bridge.krige(xy65, z65, xy65[:1], 64, model, sill, nugget, a)
        bridge.krige(xy65, z65, xy65, 64, model, sill, nugget, a, self_index=numpy.arange(65))
        loo65, loo65_var = bridge.krige(xy65, z65, xy65, 64, model, sill, nugget, a, self_index=numpy.arange(65))
    finally:
        numpy.linalg.solve = real_solve
    observations["systemShapesN65"] = [list(item) for item in shapes[:4]]
    expect("n=65 systems use 64 neighbors", len(shapes) > 0 and all(item[-1] == 65 for item in shapes), shapes[:3])
    mine_loo, mine_loo_var = leave_one_out(xy65, z65, sill, nugget, a, model)
    # leave_one_out is 65 global solves; compare a sample of 6 to keep this section short
    sample = numpy.array([0, 10, 20, 30, 40, 64])
    sample_diff = float(numpy.max(numpy.abs(loo65[sample] - mine_loo[sample])))
    sample_vdiff = float(numpy.max(numpy.abs(loo65_var[sample] - mine_loo_var[sample])))
    observations["loo65SampleDiff"] = sample_diff
    expect("n=65 LOO sample matches global LOO", sample_diff < 1e-6 and sample_vdiff < 1e-6, "%s %s" % (sample_diff, sample_vdiff))

def test_raster_assembly():
    rng = numpy.random.default_rng(11)
    raw = rng.uniform(0.0, 1000.0, (24, 2))
    raw[0] = [0.0, 0.0]
    raw[1] = [1000.0, 1000.0]
    values = numpy.sin(raw[:, 0] / 80.0) + numpy.cos(raw[:, 1] / 90.0)
    features = [point_feature(x, y, z) for (x, y), z in zip(raw, values)]
    path = os.path.join(work, "points.geojson")
    write_geojson(path, features)
    cell = 80.0
    result = invoke(bridge.raster_kriging, request([path], {
        "field": "v", "variogram": "spherical", "nuggetRatio": 0.1, "rangeRatio": 0.4,
        "priorWeight": 1.0, "neighbors": 64, "cellSize": cell, "layerEpsg": 3857,
    }, "asm"))
    expect("assembly kriging ok", result.get("ok") is True, clip(result.get("message")))
    if not result.get("ok"):
        return
    low, high = raw.min(0), raw.max(0)
    diagonal = float(math.hypot(*(high - low)))
    center = (low + high) / 2.0
    xy = (raw - center) / diagonal
    spread = float(values.std())
    mean = float(values.mean())
    zz = (values - mean) / spread
    lags, gammas, counts = bridge.empirical_variogram(xy, zz, numpy.random.default_rng(20261017))
    got_a, got_n, got_s, _m, _share = bridge.fit_variogram(lags, gammas, counts, "spherical", 0.1, 0.4, 1.0, len(zz))
    pad = (high - low) * 0.05
    x0, y0 = low - pad
    x1, y1 = high + pad
    width = max(1, int(math.ceil((x1 - x0) / cell - 1e-9)))
    height = max(1, int(math.ceil((y1 - y0) / cell - 1e-9)))
    columns = x0 + (numpy.arange(width) + 0.5) * cell
    rows_y = y1 - (numpy.arange(height) + 0.5) * cell
    grid_x, grid_y = numpy.meshgrid(columns, rows_y)
    targets = (numpy.column_stack([grid_x.ravel(), grid_y.ravel()]) - center) / diagonal
    pred, var = bridge.krige(xy, zz, targets, 64, "spherical", got_s, got_n, got_a)
    estimate = read_band(result["outputResources"][0])
    variance = read_band(result["outputResources"][1])
    pred_diff = float(numpy.max(numpy.abs(estimate - (pred * spread + mean).reshape(height, width))))
    var_diff = float(numpy.max(numpy.abs(variance - (var * spread ** 2).reshape(height, width))))
    observations["rasterPredDiff"] = pred_diff
    observations["rasterVarDiff"] = var_diff
    expect("kriging raster matches krige at cell centers", pred_diff < 1e-4, pred_diff)
    expect("variance raster is normalized variance times spread^2", var_diff < 1e-4, var_diff)
    # duplicates
    dup = features + [point_feature(float(raw[3, 0]), float(raw[3, 1]), float(values[3] + 4.0)), point_feature(float(raw[4, 0]), float(raw[4, 1]), float(values[4] - 2.0))]
    averaged = [dict(feature) for feature in features]
    write_geojson(os.path.join(work, "dup.geojson"), dup)
    values2 = values.copy()
    values2[3] = (values[3] + values[3] + 4.0) / 2.0
    values2[4] = (values[4] + values[4] - 2.0) / 2.0
    write_geojson(os.path.join(work, "avg.geojson"), [point_feature(x, y, z) for (x, y), z in zip(raw, values2)])
    left = invoke(bridge.raster_kriging, request([os.path.join(work, "dup.geojson")], {
        "field": "v", "variogram": "spherical", "nuggetRatio": 0.1, "rangeRatio": 0.4,
        "priorWeight": 1.0, "neighbors": 16, "cellSize": 200.0, "layerEpsg": 3857,
    }, "dup"))
    right = invoke(bridge.raster_kriging, request([os.path.join(work, "avg.geojson")], {
        "field": "v", "variogram": "spherical", "nuggetRatio": 0.1, "rangeRatio": 0.4,
        "priorWeight": 1.0, "neighbors": 16, "cellSize": 200.0, "layerEpsg": 3857,
    }, "avg"))
    expect("duplicate message", left.get("ok") is True and "同一位置的 2 个重复点" in str(left.get("message")), clip(left.get("message")))
    if left.get("ok") and right.get("ok"):
        delta = float(numpy.max(numpy.abs(read_band(left["outputResources"][0]) - read_band(right["outputResources"][0]))))
        observations["duplicateDelta"] = delta
        expect("duplicate locations match the averaged points", delta < 1e-4, delta)

def test_cluster():
    rng = numpy.random.default_rng(0)
    xy = numpy.vstack([rng.uniform(-0.15, 0.15, (40, 2)), rng.uniform(-0.15, 0.15, (40, 2)) + numpy.array([1.0, 0.0])])
    zz = numpy.array([0.0] * 40 + [1.0] * 40)
    lags, gammas, counts = bridge.empirical_variogram(xy, zz, numpy.random.default_rng(1))
    observations["clusterLags"] = int(len(lags))
    observations["clusterGammaMax"] = float(gammas.max()) if len(gammas) else None
    if len(lags) < 3:
        expect("separated clusters have several zero bins", False, "lags %s" % len(lags))
        return
    features = []
    for (x, y), value in zip(xy * 5000.0, zz * 10.0):
        features.append(point_feature(x, y, value))
    path = os.path.join(work, "clusters.geojson")
    write_geojson(path, features)
    result = invoke(bridge.raster_kriging, request([path], {
        "field": "v", "variogram": "spherical", "nuggetRatio": 0.1, "rangeRatio": 0.3,
        "priorWeight": 1.0, "neighbors": 8, "cellSize": 400.0, "layerEpsg": 3857,
    }, "cl"))
    expect("zero semivariance is rejected", result.get("ok") is False and "全为 0" in str(result.get("message")), clip(result.get("message")))

def test_watershed_math():
    dem = numpy.array([
        [30, 40, 40, 30],
        [20, 30, 30, 20],
        [10, 20, 20, 10],
        [0, 10, 10, 0],
    ], dtype="float64")
    valid = numpy.ones_like(dem, dtype=bool)
    routing = bridge.flow_routing(dem, valid, 10.0, 10.0)
    total, count, terminals = conservation(routing, valid)
    observations["valleyTerminals"] = terminals
    expect_close("two-valley conservation", total, 16, 1e-6)
    expect_close("left outlet accumulation", float(routing["accumulation"][3, 0]), 8, 1e-6)
    expect_close("right outlet accumulation", float(routing["accumulation"][3, 3]), 8, 1e-6)
    flow = strict_flow(dem, valid, 10.0)
    expect("valley strict descent and no wrap", flow["notLower"] == 0 and flow["wrapped"] == 0 and flow["nonseedSinks"] == 0, flow)
    pit = dem.copy()
    pit[1, 1] = -50
    _filled, pit_seeds = bridge.priority_flood(pit, valid)
    pit_routing = bridge.flow_routing(pit, valid, 10.0, 10.0)
    pit_total, pit_count, _pit_terminals = conservation(pit_routing, valid)
    expect("interior pit is not a flood seed", bool(pit_seeds[2, 2]) is False, "seed")
    expect_close("interior pit is lifted just above the spill", float(_filled[2, 2]), 10.0, 1e-6)
    expect("interior pit stays above the spill", float(_filled[2, 2]) > 10.0, float(_filled[2, 2]))
    expect_close("interior pit conserves cells", pit_total, float(pit_count), 1e-6)
    slope_rows, slope_cols = numpy.indices((9, 9))
    slope = ((slope_rows + slope_cols) * 2).astype("float64")
    slope[4, 4] = -100
    slope_routing = bridge.flow_routing(slope, numpy.ones_like(slope, dtype=bool), 10.0, 10.0)
    expect_close("closed depression drains to the outlet", float(slope_routing["accumulation"][0, 0]), 81, 1e-6)
    flat = numpy.full((6, 6), 5.0)
    flat_valid = numpy.ones_like(flat, dtype=bool)
    flat_routing = bridge.flow_routing(flat, flat_valid, 10.0, 10.0)
    flat_total, flat_count, flat_terminals = conservation(flat_routing, flat_valid)
    flat_flow = strict_flow(flat, flat_valid, 10.0)
    observations["flatTerminals"] = flat_terminals
    expect_close("flat conservation", flat_total, 36, 1e-6)
    expect("flat interior is not a sink", flat_flow["nonseedSinks"] == 0 and flat_terminals < 36, flat_flow)
    bowl = (numpy.abs(numpy.arange(7)[:, None] - 3) + numpy.abs(numpy.arange(7)[None, :] - 3)).astype("float64")
    bowl[3, 3] = numpy.nan
    bowl_valid = numpy.isfinite(bowl)
    bowl_routing = bridge.flow_routing(bowl, bowl_valid, 10.0, 10.0)
    bowl_total, bowl_count, _t = conservation(bowl_routing, bowl_valid)
    bowl_flow = strict_flow(bowl, bowl_valid, 10.0)
    receiver = numpy.array(bowl_routing["receiver"])
    stride = bowl_routing["stride"]
    rows, cols = numpy.indices(bowl.shape)
    padded = (rows + 1) * stride + (cols + 1)
    terminals = (receiver[padded] < 0) & bowl_valid
    hole = ~bowl_valid
    adjacent = numpy.zeros_like(hole)
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr == 0 and dc == 0:
                continue
            adjacent |= numpy.roll(numpy.roll(hole, dr, 0), dc, 1)
    adjacent &= bowl_valid
    observations["bowlTerminals"] = int(terminals.sum())
    observations["bowlTerminalsOnHole"] = int((terminals & adjacent).sum())
    expect_close("nodata bowl conservation", bowl_total, float(bowl_count), 1e-6)
    expect("nodata hole neighbors are the outlets", int((terminals & adjacent).sum()) == int(terminals.sum()) and int(terminals.sum()) > 0, observations["bowlTerminals"])
    expect("bowl non-seed cells still descend", bowl_flow["notLower"] == 0 and bowl_flow["wrapped"] == 0 and bowl_flow["nonseedSinks"] == 0, bowl_flow)
    write_tif(os.path.join(work, "bowl.tif"), bowl, [0, 10, 0, 70, 0, -10], epsg=3857)
    write_geojson(os.path.join(work, "bowl-outlet.geojson"), [point_feature(5, 65)])
    noted = invoke(bridge.raster_watershed, request([os.path.join(work, "bowl.tif"), os.path.join(work, "bowl-outlet.geojson")], {"streamArea": 1000, "snapDistance": 0, "layerEpsg": 3857}, "bowl"))
    expect("inner NoData outlets are reported", noted.get("ok") is True and "4 个像元紧邻 DEM 内部的 NoData" in str(noted.get("message")), clip(noted.get("message")))
    channel = numpy.array([[50], [40], [30], [20], [10]], dtype="float64")
    channel_valid = numpy.ones_like(channel, dtype=bool)
    channel_routing = bridge.flow_routing(channel, channel_valid, 10.0, 10.0)
    expect("channel accumulation 1..5", numpy.allclose(channel_routing["accumulation"][:, 0], [1, 2, 3, 4, 5]), channel_routing["accumulation"][:, 0].tolist())
    stride = channel_routing["stride"]
    outlets = {(1 + 1) * stride + 1: 1, (4 + 1) * stride + 1: 2}
    labels = bridge.label_basins(channel_routing, outlets)
    own1 = int(numpy.count_nonzero(labels == 1))
    own2 = int(numpy.count_nonzero(labels == 2))
    expect("nested own segment", own1 == 2 and own2 == 3, "own %s %s acc %s" % (own1, own2, channel_routing["accumulation"][:, 0].tolist()))
    acc = numpy.zeros((3, 5))
    acc[2, 0] = 5
    acc[2, 4] = 9
    valid3 = numpy.ones_like(acc, dtype=bool)
    higher = bridge.snap_outlet(acc, valid3, 2, 2, 10.0, 10.0, 30.0)
    expect("snap prefers higher accumulation", higher[:2] == (2, 4), higher)
    tie = numpy.zeros((1, 5))
    tie[0, 0] = 7
    tie[0, 3] = 7
    nearer = bridge.snap_outlet(tie, numpy.ones_like(tie, dtype=bool), 0, 2, 10.0, 10.0, 30.0)
    expect("snap tie breaks to the nearer cell", nearer[:2] == (0, 3), nearer)
    short = numpy.zeros((1, 3))
    short[0, 0] = 100
    short[0, 1] = 1
    stayed = bridge.snap_outlet(short, numpy.ones_like(short, dtype=bool), 0, 1, 10.0, 10.0, 5.0)
    expect("snap radius excludes the next cell", stayed[:2] == (0, 1), stayed)

def test_profile_and_cut():
    width, height = 20, 6
    dem = numpy.zeros((height, width))
    dem[:] = numpy.arange(width)[None, :]
    transform = [0, 10, 0, 60, 0, -10]
    write_tif(os.path.join(work, "ramp.tif"), dem, transform, epsg=3857)
    y = 35.0
    line = [[25.0, y], [175.0, y]]
    write_geojson(os.path.join(work, "ramp-line.geojson"), [line_feature(line)])
    result = invoke(bridge.raster_profile, request([os.path.join(work, "ramp.tif"), os.path.join(work, "ramp-line.geojson")], {"layerEpsg": 3857}, "ramp"))
    expect("ramp profile ok", result.get("ok") is True, clip(result.get("message")))
    if result.get("ok"):
        expect_close("ramp length m", float(result["facts"]["length"]), 150, 1e-6)
        expect_close("ramp ascent", float(result["facts"]["ascent"]), 15, 1e-6)
        expect_close("ramp descent", float(result["facts"]["descent"]), 0, 1e-6)
        expect_close("ramp min", float(result["facts"]["minimum"]), 2, 1e-6)
        expect_close("ramp max", float(result["facts"]["maximum"]), 17, 1e-6)
        features = json.load(open(os.path.join(work, result["outputResources"][0]), encoding="utf-8"))["features"]
        elevations = [feature["properties"]["elevation"] for feature in features]
        expect("ramp samples are 2..17", elevations == list(range(2, 18)), elevations)
    valley = numpy.zeros((height, width))
    valley[:] = numpy.abs(numpy.arange(width) - 10)[None, :]
    write_tif(os.path.join(work, "vdem.tif"), valley, transform, epsg=3857)
    write_geojson(os.path.join(work, "vline.geojson"), [line_feature([[25.0, y], [185.0, y]])])
    vresult = invoke(bridge.raster_profile, request([os.path.join(work, "vdem.tif"), os.path.join(work, "vline.geojson")], {"layerEpsg": 3857}, "vdev"))
    if vresult.get("ok"):
        expect_close("V ascent", float(vresult["facts"]["ascent"]), 8, 1e-6)
        expect_close("V descent", float(vresult["facts"]["descent"]), 8, 1e-6)
        expect_close("V minimum", float(vresult["facts"]["minimum"]), 0, 1e-6)
    else:
        expect("V profile", False, clip(vresult.get("message")))
    gap = dem.copy()
    gap[:, 8:11] = numpy.nan
    # Make the far side higher so the gap contributes a jump.
    gap[:, 11:] = 25
    gap[:, :8] = 10
    write_tif(os.path.join(work, "gap.tif"), gap, transform, epsg=3857)
    gresult = invoke(bridge.raster_profile, request([os.path.join(work, "gap.tif"), os.path.join(work, "ramp-line.geojson")], {"layerEpsg": 3857}, "gap"))
    observations["gapMessage"] = clip(gresult.get("message"))
    if gresult.get("ok"):
        observations["gapAscent"] = float(gresult["facts"]["ascent"])
        observations["gapMissing"] = int(gresult["facts"]["featureCount"]) 
        features = json.load(open(os.path.join(work, gresult["outputResources"][0]), encoding="utf-8"))["features"]
        missing = sum(feature["properties"]["elevation"] is None for feature in features)
        observations["gapNulls"] = missing
        expect("nodata gap reports null samples", missing >= 3, missing)
        expect_close("nodata gap does not count the jump", float(gresult["facts"]["ascent"]), 0, 1e-6)
        expect("nodata gap message says it is not counted", "不计爬升" in str(gresult.get("message")), clip(gresult.get("message")))
    else:
        expect("gap profile", False, clip(gresult.get("message")))
    multi = [line_feature([[[0, 25], [30, 25]], [[30, 25], [400, 25]]], "MultiLineString")]
    # first part is 30 long, second is much longer
    write_tif(os.path.join(work, "ml.tif"), numpy.full((4, 40), 3.0), [0, 10, 0, 40, 0, -10], epsg=3857)
    write_geojson(os.path.join(work, "ml.geojson"), multi)
    mresult = invoke(bridge.raster_profile, request([os.path.join(work, "ml.tif"), os.path.join(work, "ml.geojson")], {"layerEpsg": 3857}, "ml"))
    if mresult.get("ok"):
        expect_close("MultiLineString uses the first part", float(mresult["facts"]["length"]), 30, 1e-6)
        expect("MultiLineString sample count follows the first part", int(mresult["facts"]["featureCount"]) == 4, mresult["facts"]["featureCount"])
    else:
        expect("multiline", False, clip(mresult.get("message")))
    write_geojson(os.path.join(work, "out.geojson"), [line_feature([[-50.0, 25.0], [50.0, 25.0]])])
    oresult = invoke(bridge.raster_profile, request([os.path.join(work, "ramp.tif"), os.path.join(work, "out.geojson")], {"layerEpsg": 3857}, "out"))
    if oresult.get("ok"):
        features = json.load(open(os.path.join(work, oresult["outputResources"][0]), encoding="utf-8"))["features"]
        nulls = sum(feature["properties"]["elevation"] is None for feature in features)
        known = [feature["properties"]["elevation"] for feature in features if feature["properties"]["elevation"] is not None]
        observations["outsideNulls"] = nulls
        expect("line outside the DEM keeps the inside samples", nulls > 0 and known[0] == 0, "nulls %s first %s" % (nulls, known[:3]))
    else:
        expect("outside line", False, clip(oresult.get("message")))
    write_geojson(os.path.join(work, "zero.geojson"), [line_feature([[10.0, 10.0], [10.0, 10.0]])])
    zresult = invoke(bridge.raster_profile, request([os.path.join(work, "ramp.tif"), os.path.join(work, "zero.geojson")], {"layerEpsg": 3857}, "zero"))
    expect("zero length rejected", zresult.get("ok") is False and "长度" in str(zresult.get("message")), clip(zresult.get("message")))
    write_tif(os.path.join(work, "foot.tif"), numpy.full((4, 12), 5.0), [0, 10, 0, 40, 0, -10], unit=0.3048)
    write_geojson(os.path.join(work, "foot.geojson"), [line_feature([[5.0, 15.0], [105.0, 15.0]])])
    fresult = invoke(bridge.raster_profile, request([os.path.join(work, "foot.tif"), os.path.join(work, "foot.geojson")], {}, "foot"))
    observations["footMessage"] = clip(fresult.get("message"))
    if fresult.get("ok"):
        expect_close("foot CRS length converted to meters", float(fresult["facts"]["length"]), 30.48, 1e-3)
        expect("foot CRS label says meters", "米" in str(fresult.get("message")), clip(fresult.get("message")))
    else:
        expect("foot profile", False, clip(fresult.get("message")))
    before = numpy.full((10, 10), 100.0)
    after = before.copy()
    after[0:2, 0:2] += 3
    after[5:7, 5:7] -= 2
    base = [0, 10, 0, 100, 0, -10]
    write_tif(os.path.join(work, "before.tif"), before, base, epsg=3857)
    write_tif(os.path.join(work, "after.tif"), after, base, epsg=3857)
    cut = invoke(bridge.raster_cut_fill, request([os.path.join(work, "before.tif"), os.path.join(work, "after.tif")], {}, "cf"))
    expect("cutfill ok", cut.get("ok") is True, clip(cut.get("message")))
    if cut.get("ok"):
        expect_close("fill volume", float(cut["facts"]["fill"]), 1200, 1e-6)
        expect_close("cut volume", float(cut["facts"]["cut"]), 800, 1e-6)
        expect_close("net volume", float(cut["facts"]["net"]), 400, 1e-6)
        diff = read_band(cut["outputResources"][0])
        expect("difference sign", float(diff[0, 0]) == 3 and float(diff[5, 5]) == -2, diff[0, 0])
    write_tif(os.path.join(work, "after-shift.tif"), after, [10, 10, 0, 100, 0, -10], epsg=3857)
    shifted = invoke(bridge.raster_cut_fill, request([os.path.join(work, "before.tif"), os.path.join(work, "after-shift.tif")], {}, "cfs"))
    expect("shifted grid rejected", shifted.get("ok") is False and "同一网格" in str(shifted.get("message")), clip(shifted.get("message")))
    write_tif(os.path.join(work, "after-32650.tif"), after, base, epsg=32650)
    other = invoke(bridge.raster_cut_fill, request([os.path.join(work, "before.tif"), os.path.join(work, "after-32650.tif")], {}, "cfc"))
    expect("different CRS rejected", other.get("ok") is False and "坐标系" in str(other.get("message")), clip(other.get("message")))
    write_tif(os.path.join(work, "after-none.tif"), after, base, epsg=None)
    one = invoke(bridge.raster_cut_fill, request([os.path.join(work, "before.tif"), os.path.join(work, "after-none.tif")], {}, "cfn"))
    observations["oneSidedCrs"] = clip(one.get("message"))
    expect("one raster without CRS is rejected", one.get("ok") is False and "另一个没有" in str(one.get("message")), clip(one.get("message")))
    angle = math.radians(20)
    rotated = [0, 10 * math.cos(angle), 10 * math.sin(angle), 0, 10 * math.sin(angle), -10 * math.cos(angle)]
    write_tif(os.path.join(work, "before-rot.tif"), before, rotated, epsg=3857)
    write_tif(os.path.join(work, "after-rot.tif"), after, rotated, epsg=3857)
    rot = invoke(bridge.raster_cut_fill, request([os.path.join(work, "before-rot.tif"), os.path.join(work, "after-rot.tif")], {}, "cfr"))
    observations["rotatedCut"] = clip(rot.get("message"))
    if rot.get("ok"):
        expect_close("rotated cell area still 100", float(rot["facts"]["fill"]), 1200, 1e-4)
    else:
        expect("rotated cutfill", False, clip(rot.get("message")))
    tiny = list(base)
    tiny[0] = 500000.0001
    big = list(base)
    big[0] = 500000.0
    write_tif(os.path.join(work, "before-big.tif"), before, big, epsg=3857)
    write_tif(os.path.join(work, "after-big.tif"), after, tiny, epsg=3857)
    nudged = invoke(bridge.raster_cut_fill, request([os.path.join(work, "before-big.tif"), os.path.join(work, "after-big.tif")], {}, "cft"))
    observations["tinyShift"] = "ok" if nudged.get("ok") else clip(nudged.get("message"))
    expect("sub-millimeter origin shift at 500000 is accepted", nudged.get("ok") is True, observations["tinyShift"])

def test_edges():
    def points(count, value_of, same=False):
        features = []
        for index in range(count):
            x = 0.0 if same else float(index * 10)
            y = 0.0 if same else float((index % 7) * 10)
            features.append(point_feature(x, y, value_of(index)))
        path = os.path.join(work, "edge-%d.geojson" % count)
        write_geojson(path, features)
        return path
    params = {"field": "v", "variogram": "spherical", "nuggetRatio": 0.1, "rangeRatio": 0.3, "priorWeight": 1.0, "neighbors": 8, "cellSize": 50.0, "layerEpsg": 3857}
    few = invoke(bridge.raster_kriging, request([points(9, lambda i: float(i))], params, "few"))
    expect("fewer than 10 points", few.get("ok") is False and "10" in str(few.get("message")), clip(few.get("message")))
    many_path = os.path.join(work, "many.geojson")
    write_geojson(many_path, [point_feature(float(i % 100), float(i // 100), float(i % 5)) for i in range(5001)])
    many = invoke(bridge.raster_kriging, request([many_path], params, "many"))
    expect("more than 5000 points", many.get("ok") is False and "5000" in str(many.get("message")), clip(many.get("message")))
    constant = invoke(bridge.raster_kriging, request([points(12, lambda i: 3.0)], params, "const"))
    expect("constant values", constant.get("ok") is False and "全部相同" in str(constant.get("message")), clip(constant.get("message")))
    same = invoke(bridge.raster_kriging, request([points(15, lambda i: float(i), True)], params, "same"))
    observations["sameLocation"] = clip(same.get("message"))
    expect("identical locations", same.get("ok") is False, observations["sameLocation"])
    geo = dict(params)
    geo["layerEpsg"] = 4326
    geographic = invoke(bridge.raster_kriging, request([points(12, lambda i: float(i))], geo, "geo"))
    expect("geographic kriging rejected", geographic.get("ok") is False and "投影" in str(geographic.get("message")), clip(geographic.get("message")))
    unknown = dict(params)
    del unknown["layerEpsg"]
    unknown["cellSize"] = 100.0
    plain = invoke(bridge.raster_kriging, request([points(12, lambda i: float(i))], unknown, "unk"))
    observations["unknownKriging"] = clip(plain.get("message"))
    expect("unknown CRS kriging uses coordinate units", plain.get("ok") is True and "坐标单位" in str(plain.get("message")), observations["unknownKriging"])
    tiny = dict(params)
    tiny["cellSize"] = 0.5
    write_geojson(os.path.join(work, "wide.geojson"), [point_feature(0, 0, 1), point_feature(10000, 10000, 2)] + [point_feature(float(i * 100), float(i * 80), float(i)) for i in range(2, 12)])
    too_small = invoke(bridge.raster_kriging, request([os.path.join(work, "wide.geojson")], tiny, "tiny2"))
    expect("cell size over 250000 rejected", too_small.get("ok") is False and "25" in str(too_small.get("message")), clip(too_small.get("message")))
    transform = [0, 10, 0, 40, 0, -10]
    small = numpy.arange(16, dtype="float64").reshape(4, 4)
    write_tif(os.path.join(work, "small.tif"), small, transform, epsg=3857)
    outlets = [point_feature(5 + (i % 4) * 0.1, 5 + (i // 4) * 0.1) for i in range(51)]
    write_geojson(os.path.join(work, "outlets51.geojson"), outlets)
    too_many = invoke(bridge.raster_watershed, request([os.path.join(work, "small.tif"), os.path.join(work, "outlets51.geojson")], {"streamArea": 1000, "snapDistance": 0, "layerEpsg": 3857}, "ws51"))
    expect("more than 50 outlets", too_many.get("ok") is False and "50" in str(too_many.get("message")), clip(too_many.get("message")))
    write_geojson(os.path.join(work, "outside.geojson"), [point_feature(1000, 1000)])
    outside = invoke(bridge.raster_watershed, request([os.path.join(work, "small.tif"), os.path.join(work, "outside.geojson")], {"streamArea": 1000, "snapDistance": 0, "layerEpsg": 3857}, "wso"))
    expect("outlet outside raster", outside.get("ok") is False and "范围" in str(outside.get("message")), clip(outside.get("message")))
    write_geojson(os.path.join(work, "pair.geojson"), [point_feature(5, 5), point_feature(6, 6)])
    paired = invoke(bridge.raster_watershed, request([os.path.join(work, "small.tif"), os.path.join(work, "pair.geojson")], {"streamArea": 1000, "snapDistance": 0, "layerEpsg": 3857}, "wsp"))
    expect("two outlets in one cell merge", paired.get("ok") is True and "同一像元" in str(paired.get("message")), clip(paired.get("message")))
    write_tif(os.path.join(work, "rot.tif"), small, [0, 10, 1, 40, 1, -10], epsg=3857)
    rotated = invoke(bridge.raster_watershed, request([os.path.join(work, "rot.tif"), os.path.join(work, "pair.geojson")], {"streamArea": 1000, "snapDistance": 0, "layerEpsg": 3857}, "wsr"))
    expect("rotated DEM watershed rejected", rotated.get("ok") is False and "旋转" in str(rotated.get("message")), clip(rotated.get("message")))
    prot = invoke(bridge.raster_profile, request([os.path.join(work, "rot.tif"), os.path.join(work, "ramp-line.geojson")], {"layerEpsg": 3857}, "prot"))
    expect("rotated DEM profile rejected", prot.get("ok") is False and "旋转" in str(prot.get("message")), clip(prot.get("message")))
    write_tif(os.path.join(work, "nocrs.tif"), small, transform, epsg=None)
    nocrs = invoke(bridge.raster_watershed, request([os.path.join(work, "nocrs.tif"), os.path.join(work, "pair.geojson")], {"streamArea": 1000, "snapDistance": 0}, "wsn"))
    expect("DEM without CRS watershed rejected", nocrs.get("ok") is False and "没有坐标系" in str(nocrs.get("message")), clip(nocrs.get("message")))
    write_tif(os.path.join(work, "gdem.tif"), small, [120, 0.01, 0, 30, 0, -0.01], epsg=4326)
    gws = invoke(bridge.raster_watershed, request([os.path.join(work, "gdem.tif"), os.path.join(work, "pair.geojson")], {"streamArea": 1000, "snapDistance": 0, "layerEpsg": 4326}, "wsg"))
    expect("geographic DEM watershed rejected", gws.get("ok") is False and "投影" in str(gws.get("message")), clip(gws.get("message")))
    write_geojson(os.path.join(work, "gline.geojson"), [line_feature([[120.01, 29.99], [120.03, 29.99]])])
    gprof = invoke(bridge.raster_profile, request([os.path.join(work, "gdem.tif"), os.path.join(work, "gline.geojson")], {"layerEpsg": 4326}, "gp"))
    expect("geographic DEM profile rejected", gprof.get("ok") is False and "投影" in str(gprof.get("message")), clip(gprof.get("message")))
    nprof = invoke(bridge.raster_profile, request([os.path.join(work, "nocrs.tif"), os.path.join(work, "ramp-line.geojson")], {}, "np"))
    # ramp-line is far outside this 4x4; use a line on it
    write_geojson(os.path.join(work, "nline.geojson"), [line_feature([[5.0, 25.0], [35.0, 25.0]])])
    nprof = invoke(bridge.raster_profile, request([os.path.join(work, "nocrs.tif"), os.path.join(work, "nline.geojson")], {}, "np2"))
    observations["nocrsProfile"] = clip(nprof.get("message"))
    expect("profile without CRS uses coordinate units", nprof.get("ok") is True and "坐标单位" in str(nprof.get("message")), observations["nocrsProfile"])

def test_training():
    groups = []
    rng = numpy.random.default_rng(19)
    for index, shift in enumerate((0.0, 80.0)):
        features = []
        for _k in range(40):
            x = float(rng.uniform(0, 500) + shift)
            y = float(rng.uniform(0, 500))
            features.append(point_feature(x, y, math.sin(x / 40.0) + math.cos(y / 50.0) + shift / 80.0))
        path = os.path.join(work, "train-%d.geojson" % index)
        write_geojson(path, features)
        groups.append({"label": "g%d" % index, "path": path, "field": "v"})
    fits = {}
    sparse = []
    orig_free = train.free_fit
    orig_sparse = train.sparse_error
    def wrapped_free(bridge_module, xy, z, model, rng_):
        result = orig_free(bridge_module, xy, z, model, rng_)
        fits.setdefault(model, []).append(result)
        return result
    def wrapped_sparse(bridge_module, xy, z, model, prior, weight, neighbors, seed):
        sparse.append((model, prior, weight))
        return orig_sparse(bridge_module, xy, z, model, prior, weight, neighbors, seed)
    train.free_fit = wrapped_free
    train.sparse_error = wrapped_sparse
    try:
        train.train_kriging(bridge, groups)
    except SystemExit as error:
        expect("two-group training ran", False, error)
        return
    finally:
        train.free_fit = orig_free
        train.sparse_error = orig_sparse
    seeds = len(train.SEEDS)
    mismatches = 0
    compared = 0
    per_model = {}
    for model, prior, _weight in sparse:
        per_model.setdefault(model, 0)
        call_index = per_model[model]
        per_model[model] += 1
        group_index = (call_index // seeds) % 2
        others = [fit for j, fit in enumerate(fits[model]) if j != group_index]
        expected = train.prior_of(others)
        compared += 1
        if abs(prior[0] - expected[0]) > 1e-9 or abs(prior[1] - expected[1]) > 1e-9:
            mismatches += 1
    observations["priorComparisons"] = compared
    expect("sparse prior uses only the other group", mismatches == 0 and compared > 0, "mismatches %s of %s" % (mismatches, compared))
    own_mismatch = 0
    own_compared = 0
    for model, prior, _weight in sparse:
        # Recompute call index per model from the grouped count already consumed.
        pass
    # Single group falls back to itself.
    fits.clear()
    sparse.clear()
    train.free_fit = wrapped_free
    train.sparse_error = wrapped_sparse
    try:
        train.train_kriging(bridge, groups[:1])
    except SystemExit as error:
        expect("one-group training ran", False, error)
    else:
        per_model = {}
        for model, prior, _weight in sparse:
            per_model.setdefault(model, 0)
            call_index = per_model[model]
            per_model[model] += 1
            expected = train.prior_of(fits[model])
            own_compared += 1
            if abs(prior[0] - expected[0]) > 1e-9 or abs(prior[1] - expected[1]) > 1e-9:
                own_mismatch += 1
        observations["singleGroupComparisons"] = own_compared
        expect("single group prior falls back to itself", own_mismatch == 0 and own_compared > 0, "mismatches %s of %s" % (own_mismatch, own_compared))
    finally:
        train.free_fit = orig_free
        train.sparse_error = orig_sparse
    transform = [500000.0, 10.0, 0.0, 3000000.0, 0.0, -10.0]
    write_tif(os.path.join(work, "burn.tif"), numpy.zeros((30, 30)), transform, epsg=32650)
    polygon = {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [[[500100, 2999800], [500200, 2999800], [500200, 2999900], [500100, 2999900], [500100, 2999800]]]}}
    dataset = gdal.Open(os.path.join(work, "burn.tif"))
    burned = train.burn(dataset, [polygon], False)
    dataset = None
    inner = burned[12:18, 12:18]
    observations["burnSum"] = int(burned.sum())
    expect("reference polygon burns in the DEM CRS", bool(inner.all()) and int(burned[0, 0]) == 0 and int(burned.sum()) >= 36, "sum %s innerMin %s" % (int(burned.sum()), int(inner.min()) if inner.size else -1))

def test_perf():
    log("perf watershed 1000")
    rows, cols = numpy.mgrid[0:1000, 0:1000]
    dem = rows * 0.01 + cols * 0.02
    dem[400:430, 400:430] -= 80
    dem[10:20, 10:20] = numpy.nan
    valid = numpy.isfinite(dem)
    started = time.perf_counter()
    routing = bridge.flow_routing(dem, valid, 10.0, 10.0)
    flow_seconds = time.perf_counter() - started
    total, count, terminals = conservation(routing, valid)
    flow = strict_flow(dem, valid, 10.0)
    observations["watershedFlowSeconds"] = flow_seconds
    observations["bigTerminals"] = terminals
    expect_close("1000x1000 conservation", total, float(count), 1e-3)
    expect("1000x1000 strict descent and no wrap", flow["notLower"] == 0 and flow["wrapped"] == 0 and flow["nonseedSinks"] == 0, flow)
    write_tif(os.path.join(work, "big.tif"), dem, [0, 10, 0, 10000, 0, -10], epsg=3857)
    write_geojson(os.path.join(work, "big-outlet.geojson"), [point_feature(50, 50)])
    started = time.perf_counter()
    full = invoke(bridge.raster_watershed, request([os.path.join(work, "big.tif"), os.path.join(work, "big-outlet.geojson")], {"streamArea": 1e6, "snapDistance": 30, "layerEpsg": 3857}, "big"))
    full_seconds = time.perf_counter() - started
    observations["watershedFullSeconds"] = full_seconds
    observations["watershedFullOk"] = full.get("ok") is True
    observations["watershedFullMessage"] = clip(full.get("message"))
    expect("1000x1000 watershed finished", full.get("ok") is True, clip(full.get("message")))
    log("perf kriging 5000")
    rng = numpy.random.default_rng(23)
    xy = rng.uniform(0, 10000, (5000, 2))
    xy[0] = [0, 0]
    xy[1] = [10000, 10000]
    zz = numpy.sin(xy[:, 0] / 800.0) + numpy.cos(xy[:, 1] / 900.0)
    write_geojson(os.path.join(work, "k5000.geojson"), [point_feature(float(x), float(y), float(z)) for (x, y), z in zip(xy, zz)])
    started = time.perf_counter()
    result = invoke(bridge.raster_kriging, request([os.path.join(work, "k5000.geojson")], {
        "field": "v", "variogram": "exponential", "nuggetRatio": 0.05, "rangeRatio": 0.3,
        "priorWeight": 10.0, "neighbors": 64, "cellSize": 22.0, "layerEpsg": 3857,
    }, "k5000"))
    krige_seconds = time.perf_counter() - started
    observations["kriging5000Seconds"] = krige_seconds
    observations["kriging5000Ok"] = result.get("ok") is True
    observations["kriging5000Facts"] = result.get("facts")
    observations["kriging5000Message"] = clip(result.get("message"))
    expect("5000-point kriging finished", result.get("ok") is True, clip(result.get("message")))
    if result.get("ok"):
        observations["kriging5000Cells"] = int(result["facts"].get("width", 0)) * int(result["facts"].get("height", 0))

def main():
    log("write service rasters")
    write_service()
    save()
    sections = [test_variogram, test_krige, test_raster_assembly, test_cluster, test_watershed_math, test_profile_and_cut, test_edges, test_training, test_perf]
    for fn in sections:
        log("section " + fn.__name__)
        try:
            fn()
        except Exception as error:
            expect(fn.__name__ + " crashed", False, "%s: %s" % (type(error).__name__, error))
        save()
    save()
    log("python done")

main()
`;

function point(x: number, y: number, properties: Record<string, number> = {}): MapFeature {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [x, y] } };
}

function modelOf(name: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    format: "igis-pro-model",
    version: 1,
    name,
    kriging: { model: "spherical", nuggetRatio: 0.1, rangeRatio: 0.4, priorWeight: 5, neighbors: 8 },
    watershed: { streamArea: 500000, snapDistance: 200 },
    trainingSets: 2,
    ...extra,
  };
}

async function readTree(directory: string): Promise<string> {
  let names: string[] = [];
  try {
    names = await readdir(directory, { recursive: true });
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const name of names) {
    try {
      parts.push(await readFile(join(directory, name), { encoding: "utf8" }));
    } catch {
      // 目录项读不了，跳过。
    }
  }
  return parts.join("\n");
}

async function main(): Promise<void> {
  const python = managedPythonPath(REPO_ROOT);
  if (python === null) throw new Error("托管 Python 不在。");
  const root = await mkdtemp(join(tmpdir(), "igis-v0932-grok-"));
  const reportPath = join(root, "report.json");
  const rasterDir = join(root, "rasters");
  const otherDir = join(root, "other");
  const otherRasters = join(otherDir, "rasters");
  await mkdir(rasterDir, { recursive: true });
  await mkdir(otherRasters, { recursive: true });
  const pyPath = join(root, "grok_verify.py");
  await writeFile(pyPath, PYTHON, { encoding: "utf8" });
  const libBin = resolve(REPO_ROOT, "var/gdal-python/Library/bin");
  const py = await run(python, [
    pyPath,
    resolve(REPO_ROOT, "packages/external-gateway/scripts/gdal-bridge.py"),
    resolve("E:/ai工作区/igis-models-private/train.py"),
    join(root, "py"),
    rasterDir,
    otherRasters,
    reportPath,
  ], { env: { ...nodeEnv, PYTHONIOENCODING: "utf-8", PATH: `${libBin};${nodeEnv.PATH ?? ""}` } });
  console.log(py.stderr.trim());
  let report: { checks?: { name: string; ok: boolean; detail: string }[]; observations?: Record<string, unknown> } = {};
  try {
    report = JSON.parse(await readFile(reportPath, { encoding: "utf8" })) as typeof report;
  } catch {
    console.log(py.stdout.slice(-2000));
  }
  for (const item of report.checks ?? []) check(item.ok, `${item.name} :: ${item.detail}`);
  console.log(`OBSERVATIONS ${JSON.stringify(report.observations ?? {})}`);
  check(py.code === 0, `python verifier exit ${py.code}`);

  const projected = projectForModel({
    msdr: 1.2,
    variogram: "spherical",
    range: 12,
    sill: 3,
    nugget: 0.4,
    streamArea: 1000,
    snapDistance: 30,
    length: 8,
    ascent: 2,
    descent: 1,
    cut: 5,
    net: -1,
    fill: 9,
    coordinates: [121.501, 31.202],
    localOutputResources: ["C:/secret/a.tif"],
  }) as Record<string, unknown>;
  for (const key of ["msdr", "variogram", "range", "sill", "nugget", "streamArea", "snapDistance", "length", "ascent", "descent", "cut", "net", "fill"]) {
    check(projected[key] !== undefined, `allowlist 保留 ${key}`);
  }
  check(projected.coordinates === undefined && projected.localOutputResources === undefined, `allowlist 丢掉坐标和 localOutputResources：${JSON.stringify(projected)}`);
  const scrubbed = projectForModel({ message: "产物 dem-slope.tif 和 ras-0123abcdef 保留" }) as { message?: string };
  check(scrubbed.message?.includes("ras-0123abcdef") === true && !scrubbed.message.includes(".tif"), `句柄保留、tif 被删：${String(scrubbed.message)}`);

  const badCases: { readonly label: string; readonly value: unknown; readonly text: string }[] = [
    { label: "format", value: { ...modelOf("a"), format: "other" }, text: "格式不对" },
    { label: "version", value: { ...modelOf("a"), version: 2 }, text: "版本不支持" },
    { label: "neighbors", value: modelOf("a", { kriging: { model: "spherical", nuggetRatio: 0.1, rangeRatio: 0.4, priorWeight: 5, neighbors: 3 } }), text: "超出范围" },
    { label: "nugget", value: modelOf("a", { kriging: { model: "spherical", nuggetRatio: 1, rangeRatio: 0.4, priorWeight: 5, neighbors: 8 } }), text: "超出范围" },
    { label: "stream", value: modelOf("a", { watershed: { streamArea: 0, snapDistance: 10 } }), text: "超出范围" },
    { label: "missing", value: { format: "igis-pro-model", version: 1, name: "a" }, text: "缺少" },
  ];
  for (const item of badCases) {
    let message = "";
    try {
      parseProModel(item.value);
    } catch (error) {
      message = error instanceof ProModelError ? error.message : String(error);
    }
    check(message.includes(item.text), `${item.label} 提示「${message}」应含「${item.text}」`);
  }
  for (const [label, value] of [
    ["顶层", modelOf("extra", { note: "x" })],
    ["kriging", modelOf("extra", { kriging: { model: "spherical", nuggetRatio: 0.1, rangeRatio: 0.4, priorWeight: 5, neighbors: 8, sill: 1 } })],
    ["watershed", modelOf("extra", { watershed: { streamArea: 1000, snapDistance: 10, fill: true } })],
  ] as const) {
    let message = "";
    try {
      parseProModel(value);
    } catch (error) {
      message = error instanceof ProModelError ? error.message : String(error);
    }
    check(message.includes("不认识的字段"), `${label}多余字段应拒绝：「${message}」`);
  }

  const processApi = (globalThis as unknown as { process: { cwd(): string; chdir(directory: string): void } }).process;
  const previous = processApi.cwd();
  processApi.chdir(root);
  try {
    const modelDir = join(root, "models");
    await mkdir(modelDir, { recursive: true });
    const bridge = resolve(REPO_ROOT, "packages/external-gateway/scripts/gdal-bridge.py");
    const boundary = new ExternalCapabilityBoundary({
      enabled: true,
      backend: createProcessBackend({ name: "python-osgeo-gdal", command: python, args: [bridge], availabilityArgs: [bridge, "--check"], env: { IGIS_BACKEND_ROOT: root } }),
    });
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "grok",
      external: boundary,
      modelDirectory: modelDir,
    });
    const adapter = createSpatialAwareAdapter({ execute: async () => ({ ok: true }) }, stack.service, { entry: "chat", operationsRoot: root });
    const call = async (tool: string, args: Record<string, string | number | boolean>): Promise<Record<string, unknown>> => adapter.execute({ tool: tool as never, args }) as Promise<Record<string, unknown>>;
    const makeLayer = async (name: string, features: readonly MapFeature[], kind: "point" | "line" | "polygon", crsLabel: string): Promise<string> => {
      const made = await stack.service.createLayer({ layerName: name, collection: { type: "FeatureCollection", features: [...features] }, crsLabel, expectedKind: kind, sourceLabel: "grok", writeKnowledge: false });
      return made.layer.layerId;
    };
    const samples = Array.from({ length: 16 }, (_item, index) => point(index * 100, (index % 4) * 100, { v: Math.sin(index) + 2 }));
    const visibleLeak = (payload: Record<string, unknown>, label: string): void => {
      const text = JSON.stringify(payload);
      check(!("localOutputResources" in payload), `${label} 模型结果没有 localOutputResources`);
      check(!text.includes("LOCAL_DATA_ACCESS_ERROR"), `${label} 没有 LOCAL_DATA_ACCESS_ERROR：${text.slice(0, 240)}`);
      check(!text.includes("121.501") && !text.includes("\"coordinates\""), `${label} 模型结果没有坐标：${text.slice(0, 240)}`);
      const message = String(payload.message ?? "");
      check(!message.includes("/") && !message.includes("\\") && !message.includes(".."), `${label} 消息没有路径符号：${message.slice(0, 240)}`);
      check(!/\.tiff?\b/i.test(message), `${label} 消息没有 tif 文件名：${message.slice(0, 240)}`);
    };

    await stack.service.usingConversationWorkspace(root, async () => {
      const points = await makeLayer("样点", samples, "point", "EPSG:3857");
      const line = await makeLayer("线", [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[100, 1000], [1900, 1000]] } }], "line", "EPSG:3857");
      const zone = await makeLayer("面", [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[200, 200], [800, 200], [800, 800], [200, 800], [200, 200]]] } }], "polygon", "EPSG:3857");
      const outlets = await makeLayer("出水口", [point(500, 200), point(1500, 200)], "point", "EPSG:3857");
      const through = await makeLayer("穿点线", [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[50, 150], [1400, 150]] } }], "line", "EPSG:3857");
      const sharedLine = await makeLayer("共享线", [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[40, 1800], [420, 1800]] } }], "line", "EPSG:3857");
      const geoLine = await makeLayer("经纬线", [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[120.02, 31.96], [120.06, 31.96]] } }], "line", "EPSG:4326");
      const noKriging = await call("map.kriging", { layerId: points, fieldName: "v", cellSize: 250 });
      const noWatershed = await call("map.watershed", { rasterName: "dem.tif", layerId: outlets });
      check(noKriging.ok === false && String(noKriging.message ?? "").includes("不可用"), `无权重克里金：${JSON.stringify(noKriging)}`);
      check(noWatershed.ok === false && String(noWatershed.message ?? "").includes("不可用"), `无权重汇水：${JSON.stringify(noWatershed)}`);
      const profile = await call("map.profile", { rasterName: "dem.tif", layerId: line, outputName: "剖面" });
      const cutFill = await call("map.cutFill", { rasterName: "dem.tif", otherRasterName: "after.tif" });
      check(profile.ok === true, `无权重剖面仍可用：${JSON.stringify(profile).slice(0, 240)}`);
      check(cutFill.ok === true, `无权重填挖方仍可用：${JSON.stringify(cutFill).slice(0, 240)}`);
      visibleLeak(profile, "剖面");
      visibleLeak(cutFill, "填挖方");
      const handle = /差值栅格 (ras-[0-9a-f]{10})/.exec(String(cutFill.message ?? ""))?.[1] ?? "";
      check(/^ras-[0-9a-f]{10}$/.test(handle) && handle === rasterHandle("dem-cutfill-after.tif"), `填挖方句柄 ${handle}`);
      const chained = await call("map.profile", { rasterName: handle, layerId: line, outputName: "差值剖面" });
      check(chained.ok === true, `句柄接剖面：${JSON.stringify(chained).slice(0, 240)}`);
      const upper = await call("map.profile", { rasterName: handle.toUpperCase(), layerId: line, outputName: "大写句柄" });
      check(upper.ok === true, `大写句柄：${JSON.stringify(upper).slice(0, 180)}`);
      const slope = await call("map.demDerivative", { rasterName: "dem.tif", derivative: "slope" });
      visibleLeak(slope, "坡度");
      const slopeHandle = /产物栅格 (ras-[0-9a-f]{10})/.exec(String(slope.message ?? ""))?.[1] ?? "";
      check(/^ras-[0-9a-f]{10}$/.test(slopeHandle), `坡度句柄：${String(slope.message ?? "").slice(0, 200)}`);
      const zonal = await call("map.zonal", { rasterName: slopeHandle, layerId: zone });
      check(zonal.ok === true, `坡度句柄接分区统计：${JSON.stringify(zonal).slice(0, 240)}`);
      const fake = await call("map.profile", { rasterName: "ras-0000000000", layerId: line });
      check(fake.ok === false && String(fake.message ?? "").includes("ras-0000000000"), `伪造句柄：${JSON.stringify(fake)}`);
      const foreign = await call("map.profile", { rasterName: rasterHandle("only-b.tif"), layerId: line });
      check(foreign.ok === false && String(foreign.message ?? "").includes(rasterHandle("only-b.tif")), `另一对话独有句柄：${JSON.stringify(foreign)}`);
      const shared = await call("map.profile", { rasterName: rasterHandle("shared.tif"), layerId: sharedLine, outputName: "甲共享" });
      check(shared.ok === true && String(shared.message ?? "").includes("最低 10") && String(shared.message ?? "").includes("最高 10"), `同名句柄解析到本对话：${String(shared.message ?? "").slice(0, 180)}`);
      const shifted = await call("map.cutFill", { rasterName: "dem.tif", otherRasterName: "after-shift.tif" });
      check(shifted.ok === false && String(shifted.message ?? "").includes("同一网格"), `错位网格：${JSON.stringify(shifted)}`);
      const otherCrs = await call("map.cutFill", { rasterName: "dem.tif", otherRasterName: "after-32650.tif" });
      check(otherCrs.ok === false && String(otherCrs.message ?? "").includes("坐标系"), `坐标系不同：${JSON.stringify(otherCrs)}`);
      const geoDem = await call("map.profile", { rasterName: "dem-geo.tif", layerId: geoLine });
      check(geoDem.ok === false && String(geoDem.message ?? "").includes("投影"), `地理 DEM 剖面：${JSON.stringify(geoDem)}`);
      const geoPoints = await makeLayer("经纬点", Array.from({ length: 12 }, (_item, index) => point(121.501 + index * 0.01, 31.202, { v: index + 1 })), "point", "EPSG:4326");
      const unknownPoints = await makeLayer("未知点", samples, "point", "Unknown");
      const few = await makeLayer("九点", samples.slice(0, 9), "point", "EPSG:3857");
      const constant = await makeLayer("常值", Array.from({ length: 12 }, (_item, index) => point(index * 80, (index % 3) * 80, { v: 4 })), "point", "EPSG:3857");
      const piled = await makeLayer("同位置", Array.from({ length: 15 }, (_item, index) => point(100, 100, { v: index })), "point", "EPSG:3857");
      await writeFile(join(modelDir, "model.json"), JSON.stringify(modelOf("bad", { format: "nope" })), { encoding: "utf8" });
      const badFile = await call("map.kriging", { layerId: points, fieldName: "v" });
      check(badFile.ok === false && String(badFile.message ?? "").includes("重新安装"), `坏文件：${JSON.stringify(badFile)}`);
      await writeFile(join(modelDir, "model.json"), JSON.stringify(modelOf("alpha")), { encoding: "utf8" });
      const first = await call("map.kriging", { layerId: points, fieldName: "v", cellSize: 400 });
      check(first.ok === true && String(first.message ?? "").includes("alpha") && /ras-[0-9a-f]{10}/.test(String(first.message ?? "")), `克里金 alpha：${String(first.message ?? "").slice(0, 220)}`);
      visibleLeak(first, "克里金");
      const krigingHandle = /克里金值栅格 (ras-[0-9a-f]{10})/.exec(String(first.message ?? ""))?.[1] ?? "";
      const krigingChain = await call("map.profile", { rasterName: krigingHandle, layerId: through, outputName: "克里金剖面" });
      check(krigingChain.ok === true, `克里金句柄接剖面：${JSON.stringify(krigingChain).slice(0, 180)}`);
      await writeFile(join(modelDir, "model.json"), JSON.stringify(modelOf("beta")), { encoding: "utf8" });
      const second = await call("map.kriging", { layerId: points, fieldName: "v", cellSize: 400 });
      check(second.ok === true && String(second.message ?? "").includes("beta") && !String(second.message ?? "").includes("alpha"), `替换权重立即生效：${String(second.message ?? "").slice(0, 160)}`);
      const unknown = await call("map.kriging", { layerId: unknownPoints, fieldName: "v", cellSize: 400 });
      check(unknown.ok === true && String(unknown.message ?? "").includes("坐标单位"), `Unknown 克里金：${String(unknown.message ?? "").slice(0, 180)}`);
      const tooFew = await call("map.kriging", { layerId: few, fieldName: "v" });
      check(tooFew.ok === false && String(tooFew.message ?? "").includes("10"), `少于 10 点：${JSON.stringify(tooFew)}`);
      const flat = await call("map.kriging", { layerId: constant, fieldName: "v" });
      check(flat.ok === false && String(flat.message ?? "").includes("全部相同"), `值全部相同：${JSON.stringify(flat)}`);
      const geoK = await call("map.kriging", { layerId: geoPoints, fieldName: "v" });
      check(geoK.ok === false && String(geoK.message ?? "").includes("投影"), `地理坐标克里金：${JSON.stringify(geoK)}`);
      const rotated = await call("map.watershed", { rasterName: "dem-rot.tif", layerId: outlets });
      check(rotated.ok === false && String(rotated.message ?? "").includes("旋转"), `旋转 DEM：${JSON.stringify(rotated)}`);
      const nocrs = await call("map.watershed", { rasterName: "dem-nocrs.tif", layerId: outlets });
      check(nocrs.ok === false && String(nocrs.message ?? "").includes("没有坐标系"), `无坐标系 DEM：${JSON.stringify(nocrs)}`);
      const pile = await call("map.kriging", { layerId: piled, fieldName: "v" });
      console.log(`OBSERVE same-location ${JSON.stringify(pile)}`);
      check(pile.ok === false, `同一位置：${JSON.stringify(pile)}`);
      const tiny = await call("map.kriging", { layerId: points, fieldName: "v", cellSize: 0.2 });
      check(tiny.ok === false && String(tiny.message ?? "").includes("25"), `格网过大：${JSON.stringify(tiny)}`);
      const watershed = await call("map.watershed", { rasterName: "dem.tif", layerId: outlets, outputName: "流域" });
      check(watershed.ok === true && /ras-[0-9a-f]{10}/.test(String(watershed.message ?? "")), `汇水：${String(watershed.message ?? "").slice(0, 240)}`);
      visibleLeak(watershed, "汇水");
      const outside = await makeLayer("界外", [point(50000, 50000)], "point", "EPSG:3857");
      const outsideResult = await call("map.watershed", { rasterName: "dem.tif", layerId: outside });
      check(outsideResult.ok === false && String(outsideResult.message ?? "").includes("范围"), `出水口在栅格外：${JSON.stringify(outsideResult)}`);
      const doubled = await makeLayer("重合出水口", [point(510, 180), point(530, 170)], "point", "EPSG:3857");
      const merged = await call("map.watershed", { rasterName: "dem.tif", layerId: doubled, outputName: "合并流域" });
      check(merged.ok === true && String(merged.message ?? "").includes("同一像元"), `两出水口同一像元：${String(merged.message ?? "").slice(0, 220)}`);
      const mismatch = await makeLayer("经纬出水口", [point(121.501, 31.202)], "point", "EPSG:4326");
      const mismatched = await call("map.watershed", { rasterName: "dem.tif", layerId: mismatch });
      check(mismatched.ok === false && String(mismatched.message ?? "").includes("坐标系"), `出水口坐标系不同：${JSON.stringify(mismatched)}`);
      const plainProfile = await call("map.profile", { rasterName: "dem-nocrs.tif", layerId: line, outputName: "无坐标系剖面" });
      check(plainProfile.ok === true && String(plainProfile.message ?? "").includes("坐标单位"), `无坐标系剖面：${String(plainProfile.message ?? "").slice(0, 180)}`);
    });
    await stack.service.usingConversationWorkspace(otherDir, async () => {
      const line = await makeLayer("乙线", [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[40, 1800], [420, 1800]] } }], "line", "EPSG:3857");
      const shared = await call("map.profile", { rasterName: rasterHandle("shared.tif"), layerId: line, outputName: "乙共享" });
      check(shared.ok === true && String(shared.message ?? "").includes("最低 99"), `另一对话同名文件是 99：${String(shared.message ?? "").slice(0, 180)}`);
    });
    const auditText = await readTree(join(root, "audit"));
    const operationText = await readTree(join(root, "var", "operations"));
    check(auditText.length > 0, "审计目录有记录");
    check(!auditText.includes("\"coordinates\"") && !auditText.includes("121.501") && !auditText.includes("31.202"), "审计记录没有坐标");
    check(!operationText.includes("\"coordinates\"") && !operationText.includes("121.501"), "操作记录没有坐标");
    console.log(`OBSERVE auditHasPath ${auditText.includes("outputFilePath")}`);
  } finally {
    processApi.chdir(previous);
  }

  const installRoot = join(root, "install");
  await mkdir(installRoot, { recursive: true });
  const goodPath = join(root, "good-model.json");
  const badPath = join(root, "bad-model.json");
  await writeFile(goodPath, JSON.stringify(modelOf("installed-name")), { encoding: "utf8" });
  await writeFile(badPath, "{", { encoding: "utf8" });
  const npx = platform === "win32" ? "npx.cmd" : "npx";
  const tsconfig = resolve(REPO_ROOT, "tsconfig.json");
  const installer = resolve(REPO_ROOT, "apps/cli/src/pro-model-install.ts");
  const installed = await run(npx, ["--yes", "tsx", "--tsconfig", tsconfig, installer, goodPath], { cwd: installRoot, shell: true });
  console.log(`OBSERVE install ${installed.stdout.trim()} ${installed.stderr.trim()}`);
  let installedModel: { name?: string } | null = null;
  try {
    installedModel = parseProModel(JSON.parse(await readFile(join(installRoot, "var", "models", "igis-pro", "model.json"), { encoding: "utf8" })) as unknown);
  } catch (error) {
    check(false, `安装结果读不了：${error instanceof Error ? error.message : String(error)} :: ${installed.stderr}`);
  }
  check(installed.code === 0 && installedModel?.name === "installed-name", `安装成功 exit ${installed.code} name ${installedModel?.name ?? ""}`);
  const rejected = await run(npx, ["--yes", "tsx", "--tsconfig", tsconfig, installer, badPath], { cwd: installRoot, shell: true });
  check(rejected.code !== 0 && rejected.stderr.includes("JSON"), `坏文件拒绝 exit ${rejected.code}：${rejected.stderr.trim()}`);

  await rm(root, { recursive: true, force: true });
  if (failures.length > 0) {
    console.log(`v0932-grok-check failed ${failures.length}`);
    throw new Error(failures.join("\n"));
  }
  console.log("v0932-grok-check passed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  (globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1;
});
