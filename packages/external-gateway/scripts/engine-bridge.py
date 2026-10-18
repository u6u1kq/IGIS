#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""引擎桥（V0.94.2）：stdin 收 JSON 请求，stdout 出 JSON 结果。

由 var/engines-python 运行。降雨径流用 ANUGA，降雨滑坡用 TRIGRS，地层体用 LoopStructural。
这里只准备输入、调用引擎、读回结果，不写浅水方程或边坡稳定公式。
每次请求只跑一个情景。路径和坐标只在本进程内，逐时刻摘要写进本地 JSON，由 Node 读取。
"""

import contextlib
import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

for _stream in (sys.stdin, sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure is not None:
        _reconfigure(encoding="utf-8")

# engines-python 是建在 gdal-python 上的虚拟环境，GDAL 和 numpy 的 DLL 在基础环境的 Library\bin。
if os.name == "nt":
    for _prefix in (sys.prefix, sys.base_prefix):
        _library_bin = os.path.join(_prefix, "Library", "bin")
        if os.path.isdir(_library_bin) and _library_bin.lower() not in os.environ.get("PATH", "").lower().split(os.pathsep):
            os.environ["PATH"] = _library_bin + os.pathsep + os.environ.get("PATH", "")

_spec = importlib.util.spec_from_file_location("gdal_bridge", os.path.join(os.path.dirname(os.path.abspath(__file__)), "gdal-bridge.py"))
gb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gb)

ok = gb.ok
fail = gb.fail
finite_number = gb.finite_number

ENGINE_TIMEOUT_SECONDS = 1800
RUNOFF_MAX_CELLS = 4096
GEOLOGY_GRID = (32, 32, 16)


@contextlib.contextmanager
def quiet():
    """引擎往 stdout 打日志。计算期间把文件描述符 1 指到 stderr，结果 JSON 才不会被冲掉。"""
    sys.stdout.flush()
    saved = os.dup(1)
    os.dup2(2, 1)
    try:
        yield
    finally:
        sys.stdout.flush()
        os.dup2(saved, 1)
        os.close(saved)


def engine_dir():
    root = os.environ.get("IGIS_BACKEND_ROOT", os.getcwd())
    return os.environ.get("IGIS_ENGINE_DIR") or os.path.join(root, "var", "engines")


def trigrs_executable():
    name = "trigrs.exe" if os.name == "nt" else "trigrs"
    return os.path.join(engine_dir(), "trigrs", name)


def number(parameters, key, label, low=None, high=None, low_open=False):
    value = parameters.get(key)
    if not finite_number(value):
        fail(f"{label}没写。请向用户问，程序不会填一个数。")
    value = float(value)
    if low is not None and (value < low or (low_open and value == low)):
        fail(f"{label}超出范围。")
    if high is not None and value > high:
        fail(f"{label}超出范围。")
    return value


def open_metric_dem(resource, label):
    """打开高程栅格，要求以米为单位的投影坐标、正方形像元、没有旋转。"""
    from osgeo import gdal

    gdal.UseExceptions()
    dataset = gdal.Open(gb.resolve_resource(resource))
    if dataset is None:
        fail("无法打开高程栅格。")
    unit = gb.planar_unit(dataset.GetProjection(), label)
    if unit is None:
        fail(f"{label}需要坐标系。这个高程栅格没有坐标系，请先给它指定以米为单位的投影坐标系。")
    if abs(unit - 1.0) > 1e-9:
        fail(f"{label}需要以米为单位的投影坐标。请先投影到米制坐标系。")
    transform = dataset.GetGeoTransform()
    if abs(transform[2]) > 1e-12 or abs(transform[4]) > 1e-12:
        fail(f"{label}不支持旋转的栅格。")
    return dataset


def write_asc(path, array, transform, nodata=-9999.0):
    import numpy

    rows, cols = array.shape
    with open(path, "w", encoding="ascii", newline="\n") as handle:
        handle.write(f"ncols         {cols}\n")
        handle.write(f"nrows         {rows}\n")
        handle.write(f"xllcorner     {transform[0]:.6f}\n")
        handle.write(f"yllcorner     {transform[3] + rows * transform[5]:.6f}\n")
        handle.write(f"cellsize      {abs(transform[1]):.6f}\n")
        handle.write(f"NODATA_value  {nodata:.0f}\n")
        numpy.savetxt(handle, array, fmt="%.4f")


def read_asc(path):
    import numpy

    with open(path, "r", encoding="ascii", errors="replace") as handle:
        header = [handle.readline() for _ in range(6)]
        nodata = float(header[5].split()[1])
        values = numpy.loadtxt(handle, dtype="float64", ndmin=2)
    return values, nodata


def write_tif(path, array, transform, projection, nodata=-9999.0):
    from osgeo import gdal

    rows, cols = array.shape
    dataset = gdal.GetDriverByName("GTiff").Create(path, cols, rows, 1, gdal.GDT_Float32)
    dataset.SetGeoTransform(transform)
    dataset.SetProjection(projection)
    band = dataset.GetRasterBand(1)
    band.SetNoDataValue(nodata)
    band.WriteArray(array.astype("float32"))
    dataset.FlushCache()
    dataset = None


def output_times(total_seconds, steps):
    return [total_seconds * (index + 1) / steps for index in range(steps)]


def write_summary(request, suffix, summary):
    destination = gb.output_path(request, suffix)
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False)
    return destination


# ---- 降雨滑坡：TRIGRS 2.1（USGS，公有领域） ----

TR_IN = """Name of project (up to 255 characters)
IGIS rainfall landslide scenario
tx, nmax, mmax, zones
{tx},   30,   100,   1
nzs,  zmin,  uww,    nper    t
10,   0.001,  9.8e3,   1,  {total:.6g}
zmax,   depth,   rizero,  Min_Slope_Angle (degrees), Max_Slope_Angle (degrees)
{zmax:.6g},  {depth:.6g},  {rizero:.6g},       0.,  90.0
zone, 1
cohesion,phi,  uws,   diffus,   K-sat, Theta-sat,Theta-res,Alpha
{cohesion:.6g}, {phi:.6g}, {uws:.6g}, {diffus:.6g}, {ksat:.6g},   0.45,    0.05,    -1.0
cri(1), cri(2), ..., cri(nper)
{rain:.6g}
capt(1), capt(2), ..., capt(n), capt(n+1)
0, {total:.6g}
File name of slope angle grid (slofil)
slope.asc
File name of digital elevation grid (elevfil)
dem.asc
File name of property zone grid (zonfil)
none
File name of depth grid (zfil)
none
File name of initial depth of water table grid   (depfil)
none
File name of initial infiltration rate grid   (rizerofil)
none
List of file name(s) of rainfall intensity for each period, (rifil())
none
File name of grid of D8 runoff receptor cell numbers (nxtfil)
no_input
File name of list of cells defining runoff computation order (ndxfil)
no_input
File name of list of all runoff receptor cells  (dscfil)
no_input
File name of list of runoff weighting factors  (wffil)
no_input
Folder where output grid files will be stored  (folder)
out/
Identification code to be added to names of output files (suffix)
igis
Save grid files of runoff? Enter T (.true.) or F (.false.)
F
Save grid of minimum factor of safety? Enter T (.true.) or F (.false.)
T
Save grid of depth of minimum factor of safety? Enter T (.true.) or F (.false.)
F
Save grid of pressure head at depth of minimum factor of safety? Enter T (.true.) or F (.false.)
F
Save grid of computed water table depth or elevation? Enter T (.true.) or F (.false.) followed by 'depth,' or 'eleva'
F, depth
Save grid files of actual infiltration rate? Enter T (.true.) or F (.false.)
F
Save grid files of unsaturated zone basal flux? Enter T (.true.) or F (.false.)
F
Save listing of pressure head and factor of safety ("flag")? Enter flag value followed by down-sampling interval (integer).
0,1
Number of times to save output grids and (or) ijz/xmdv files
{count}
Times of output grids and (or) ijz / xmdv files
{times}
Skip other timesteps? Enter T (.true.) or F (.false.)
F
Use analytic solution for fillable porosity?  Enter T (.true.) or F (.false.)
T
Estimate positive pressure head in rising water table zone (i.e. in lower part of unsat zone)?  Enter T (.true.) or F (.false.)
T
Use psi0=-1/alpha? Enter T (.true.) or F (.false.) (False selects the default value, psi0=0)
F
Log mass balance results?   Enter T (.true.) or F (.false.)
F
Flow direction (Enter "gener", "slope", or "hydro")
gener
Add steady background flux to transient infiltration rate to prevent drying beyond the initial conditions during periods of zero infiltration?
T
Specify file extension for output grids. Enter T (.true.) for ".asc" or F for ".txt"
T
Ignore negative pressure head in computing factor of safety (saturated infiltration only)?   Enter T (.true.) or F (.false.)
T
Ignore height of capillary fringe in computing pressure head for unsaturated infiltration option?   Enter T (.true.) or F (.false.)
T
Parameters for deep pressure-head estimate in SCOOPS ijz output: Depth below ground surface (positive, use negative value to cancel this option), pressure option (enter 'zero' , 'flow' , 'hydr' , or 'relh')
-50.0,flow
"""


def engine_landslide(request):
    import numpy
    from osgeo import gdal

    parameters = request["parameters"]
    rain_mm_h = number(parameters, "rainIntensity", "雨强", 0.0, 1000.0, low_open=True)
    rain_hours = number(parameters, "rainHours", "降雨时长", 0.0, 720.0, low_open=True)
    cohesion_kpa = number(parameters, "cohesion", "土体黏聚力", 0.0, 1000.0)
    friction = number(parameters, "frictionAngle", "内摩擦角", 0.0, 89.0, low_open=True)
    unit_weight = number(parameters, "unitWeight", "土体重度", 0.0, 40.0, low_open=True)
    diffusivity = number(parameters, "diffusivity", "水力扩散系数", 0.0, 1.0, low_open=True)
    ksat = number(parameters, "ksat", "饱和渗透系数", 0.0, 1.0, low_open=True)
    soil_depth = number(parameters, "soilDepth", "土层厚度", 0.0, 100.0, low_open=True)
    water_table = number(parameters, "waterTableDepth", "初始地下水位埋深", 0.0, 100.0)
    background = number(parameters, "backgroundRate", "初始入渗率", 0.0, 1000.0)
    steps = int(number(parameters, "steps", "输出时刻数", 1, 24))
    if water_table > soil_depth:
        fail("初始地下水位埋深大于土层厚度。请核对这两个数。")
    executable = trigrs_executable()
    if not os.path.isfile(executable):
        fail("TRIGRS 没有装。请先在设置里安装计算引擎。")

    dataset = open_metric_dem(request["inputResources"][0], "降雨滑坡")
    transform = dataset.GetGeoTransform()
    if abs(abs(transform[1]) - abs(transform[5])) > 1e-6 * abs(transform[1]):
        fail("TRIGRS 需要正方形像元。请先用 map.resample 把高程栅格重采样成正方形像元。")
    band = dataset.GetRasterBand(1)
    elevation = band.ReadAsArray().astype("float64")
    valid = gb.valid_mask(elevation, band.GetNoDataValue())
    if numpy.count_nonzero(valid) < 4:
        fail("高程栅格的有效像元太少。")
    slope_dataset = gdal.DEMProcessing("", dataset, "slope", format="MEM", computeEdges=True)
    slope = slope_dataset.GetRasterBand(1).ReadAsArray().astype("float64")
    slope_dataset = None
    slope_valid = valid & numpy.isfinite(slope) & (slope >= 0)
    rain_m_s = rain_mm_h / 1000.0 / 3600.0
    total = rain_hours * 3600.0
    times = output_times(total, steps)
    work = tempfile.mkdtemp(prefix="igis-trigrs-")
    try:
        os.makedirs(os.path.join(work, "out"), exist_ok=True)
        write_asc(os.path.join(work, "dem.asc"), numpy.where(valid, elevation, -9999.0), transform)
        write_asc(os.path.join(work, "slope.asc"), numpy.where(slope_valid, slope, -9999.0), transform)
        control = TR_IN.format(
            tx=2 * steps,
            total=total,
            zmax=soil_depth,
            depth=water_table,
            rizero=background / 1000.0 / 3600.0,
            cohesion=cohesion_kpa * 1000.0,
            phi=friction,
            uws=unit_weight * 1000.0,
            diffus=diffusivity,
            ksat=ksat,
            rain=rain_m_s,
            count=steps,
            times=", ".join(f"{value:.6g}" for value in times),
        )
        with open(os.path.join(work, "tr_in.txt"), "w", encoding="ascii", newline="\n") as handle:
            handle.write(control)
        try:
            completed = subprocess.run([executable], cwd=work, input="\n", capture_output=True, text=True, timeout=ENGINE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            fail("TRIGRS 超时没有算完。")
        if "output times unavailable" in (completed.stdout or ""):
            fail("TRIGRS 没有在要求的时刻输出，换成了别的时刻。这次结果不用。")
        cell_area = abs(transform[1] * transform[5])
        projection = dataset.GetProjection()
        records = []
        outputs = []
        for index, seconds in enumerate(times, start=1):
            produced = os.path.join(work, "out", f"TRfs_min_igis_{index}.asc")
            if not os.path.isfile(produced):
                tail = (completed.stdout or "").strip().splitlines()[-3:]
                fail("TRIGRS 没有写出安全系数栅格。" + (" 引擎输出：" + " / ".join(tail) if tail else ""))
            values, nodata = read_asc(produced)
            if values.shape != elevation.shape:
                fail("TRIGRS 的输出网格和高程栅格不一致。")
            fs_valid = numpy.isfinite(values) & (values != nodata) & valid
            if not fs_valid.any():
                fail("TRIGRS 的安全系数栅格没有有效像元。")
            unstable = fs_valid & (values < 1.0)
            destination = gb.output_path(request, f"-fs{index}.tif")
            write_tif(destination, numpy.where(fs_valid, values, -9999.0), transform, projection)
            outputs.append(gb.relative(destination))
            records.append({
                "hours": seconds / 3600.0,
                "minFs": float(values[fs_valid].min()),
                "unstableArea": float(numpy.count_nonzero(unstable) * cell_area),
                "unstableCells": int(numpy.count_nonzero(unstable)),
            })
    finally:
        shutil.rmtree(work, ignore_errors=True)
    summary = {"kind": "landslide", "steps": records, "cellArea": cell_area}
    outputs.append(gb.relative(write_summary(request, "-landslide.json", summary)))
    last = records[-1]
    ok(
        facts={"featureCount": last["unstableCells"], "minimum": last["minFs"]},
        message=f"TRIGRS 已按雨强 {rain_mm_h:.6g} 毫米每小时、历时 {rain_hours:.6g} 小时算完 {steps} 个时刻。",
        outputs=outputs,
    )


# ---- 降雨径流：ANUGA 4（Apache-2.0） ----

def coarse_grid(dataset, label):
    """像元太多时按整数倍取平均变粗。返回高程、有效掩膜、地理变换和倍数。"""
    import numpy
    from osgeo import gdal

    cols, rows = dataset.RasterXSize, dataset.RasterYSize
    factor = max(1, int(math.ceil(math.sqrt(cols * rows / RUNOFF_MAX_CELLS))))
    if factor > 1:
        transform = dataset.GetGeoTransform()
        width = max(2, cols // factor)
        height = max(2, rows // factor)
        coarse = gdal.Warp("", dataset, format="MEM", width=width, height=height,
                           outputBounds=(transform[0], transform[3] + height * factor * transform[5], transform[0] + width * factor * transform[1], transform[3]),
                           resampleAlg="average")
        dataset = coarse
    band = dataset.GetRasterBand(1)
    elevation = band.ReadAsArray().astype("float64")
    valid = gb.valid_mask(elevation, band.GetNoDataValue())
    if not valid.all():
        fail(f"{label}需要完整的高程网格，这个栅格有空值像元。请先裁剪到没有空值的范围，或用 map.rasterNodata 处理后再算。")
    return elevation, dataset.GetGeoTransform(), factor


def engine_runoff(request):
    import numpy

    parameters = request["parameters"]
    rain_mm_h = number(parameters, "rainIntensity", "雨强", 0.0, 1000.0, low_open=True)
    rain_hours = number(parameters, "rainHours", "降雨时长", 0.0, 24.0, low_open=True)
    total_hours = number(parameters, "simulationHours", "模拟总时长", 0.0, 24.0, low_open=True)
    manning = number(parameters, "manning", "曼宁糙率", 0.0, 1.0, low_open=True)
    steps = int(number(parameters, "steps", "输出时刻数", 1, 24))
    threshold = number(parameters, "depthThreshold", "统计面积用的水深下限", 0.0, 100.0)
    edges = str(parameters.get("boundary") or "open")
    if edges not in ("open", "closed"):
        fail("边界只能是 open（四周自由出流）或 closed（四周封闭）。")
    if total_hours < rain_hours:
        fail("模拟总时长短于降雨时长。请核对这两个数。")
    dataset = open_metric_dem(request["inputResources"][0], "降雨径流")
    elevation, transform, factor = coarse_grid(dataset, "降雨径流")
    rows, cols = elevation.shape
    dx = abs(transform[1])
    dy = abs(transform[5])
    rain_m_s = rain_mm_h / 1000.0 / 3600.0
    rain_seconds = rain_hours * 3600.0
    total = total_hours * 3600.0
    times = output_times(total, steps)
    projection = dataset.GetProjection()
    work = tempfile.mkdtemp(prefix="igis-anuga-")
    records = []
    outputs = []
    try:
        with quiet():
            import anuga

            domain = anuga.rectangular_cross_domain(cols, rows, len1=cols * dx, len2=rows * dy)
            domain.set_name("igis_runoff")
            domain.set_datadir(work)
            centroids = domain.centroid_coordinates
            column = numpy.clip((centroids[:, 0] / dx).astype(int), 0, cols - 1)
            row_from_bottom = numpy.clip((centroids[:, 1] / dy).astype(int), 0, rows - 1)
            row = rows - 1 - row_from_bottom
            cell = row * cols + column
            bed = elevation[row, column]
            domain.set_quantity("elevation", bed, location="centroids")
            domain.set_quantity("friction", manning, location="centroids")
            domain.set_quantity("stage", bed, location="centroids")
            # 透射边界会凭空进水。出流用远低于床面的定水位，封闭用反射边界。
            if edges == "open":
                boundary = anuga.Dirichlet_boundary([float(elevation.min()) - 10.0, 0.0, 0.0])
            else:
                boundary = anuga.Reflective_boundary(domain)
            domain.set_boundary({"left": boundary, "right": boundary, "top": boundary, "bottom": boundary})
            # 干地上没有波速限制，一步会跨过整个输出间隔。
            domain.set_evolve_max_timestep(1.0)
            anuga.Rate_operator(domain, rate=lambda t: rain_m_s if t < rain_seconds else 0.0, factor=1.0)
            cell_count = rows * cols
            peak_speed = numpy.zeros(cell_count)
            next_index = 0
            yield_step = times[0]
            for now in domain.evolve(yieldstep=yield_step, finaltime=total):
                if next_index >= len(times) or now + 1e-6 < times[next_index]:
                    continue
                stage = domain.quantities["stage"].centroid_values
                xmom = domain.quantities["xmomentum"].centroid_values
                ymom = domain.quantities["ymomentum"].centroid_values
                depth = numpy.maximum(stage - bed, 0.0)
                stored = float((depth * domain.areas).sum())
                speed = numpy.where(depth > 1e-3, numpy.hypot(xmom, ymom) / numpy.maximum(depth, 1e-3), 0.0)
                cell_depth = numpy.bincount(cell, weights=depth, minlength=cell_count) / numpy.maximum(numpy.bincount(cell, minlength=cell_count), 1)
                cell_speed = numpy.zeros(cell_count)
                numpy.maximum.at(cell_speed, cell, speed)
                peak_speed = numpy.maximum(peak_speed, cell_speed)
                grid = cell_depth.reshape(rows, cols)
                next_index += 1
                destination = gb.output_path(request, f"-depth{next_index}.tif")
                write_tif(destination, grid, transform, projection)
                outputs.append(gb.relative(destination))
                wet = grid > threshold
                records.append({
                    "hours": now / 3600.0,
                    "maxDepth": float(grid.max()),
                    "wetArea": float(numpy.count_nonzero(wet) * dx * dy),
                    "maxSpeed": float(cell_speed.max()),
                    "volume": stored,
                    "rained": rain_m_s * min(now, rain_seconds) * rows * cols * dx * dy,
                })
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if len(records) < len(times):
        fail("ANUGA 没有算到全部输出时刻。")
    speed_destination = gb.output_path(request, "-speed.tif")
    write_tif(speed_destination, peak_speed.reshape(rows, cols), transform, projection)
    outputs.append(gb.relative(speed_destination))
    rained = rain_m_s * rain_seconds * rows * cols * dx * dy
    summary = {"kind": "runoff", "steps": records, "cell": dx, "factor": factor, "rainVolume": rained, "threshold": threshold, "boundary": edges}
    outputs.append(gb.relative(write_summary(request, "-runoff.json", summary)))
    ok(
        facts={"maximum": max(item["maxDepth"] for item in records)},
        message=f"ANUGA 已按雨强 {rain_mm_h:.6g} 毫米每小时、历时 {rain_hours:.6g} 小时、模拟 {total_hours:.6g} 小时算完 {steps} 个时刻。",
        outputs=outputs,
    )


# ---- 地层体：LoopStructural 1.x（MIT） ----

def engine_geology(request):
    import numpy

    parameters = request["parameters"]
    contact_field = str(parameters.get("contactField") or "").strip()
    dip_field = str(parameters.get("dipField") or "").strip()
    azimuth_field = str(parameters.get("azimuthField") or "").strip()
    if not contact_field or not dip_field or not azimuth_field:
        fail("地层体需要界面字段、倾角字段和倾向字段。")
    depth = number(parameters, "depth", "模型向下延伸的深度", 0.0, 100000.0, low_open=True)
    resources = request["inputResources"]
    features = gb.read_features(resources[0])
    dem = None
    dem_valid = None
    dem_transform = None
    if len(resources) > 1:
        dem_dataset = open_metric_dem(resources[1], "地层体")
        gb.check_layer_crs(dem_dataset, request)
        band = dem_dataset.GetRasterBand(1)
        dem = band.ReadAsArray().astype("float64")
        dem_valid = gb.valid_mask(dem, band.GetNoDataValue())
        dem_transform = dem_dataset.GetGeoTransform()
    else:
        epsg = parameters.get("layerEpsg")
        if finite_number(epsg):
            from osgeo import osr

            srs = osr.SpatialReference()
            if srs.ImportFromEPSG(int(epsg)) == 0:
                gb.planar_unit(srs.ExportToWkt(), "地层体")
    rows = []
    for feature in features:
        geometry = feature.get("geometry") or {}
        properties = feature.get("properties") or {}
        if geometry.get("type") != "Point":
            continue
        triple = geometry.get("coordinates") or []
        if len(triple) < 2 or not finite_number(triple[0]) or not finite_number(triple[1]):
            continue
        x, y = float(triple[0]), float(triple[1])
        if dem is not None:
            z = gb.sample_raster(dem, dem_valid, dem_transform, x, y)
            if z is None:
                fail("有界面点落在高程栅格外或空值像元上。请换高程栅格或删掉这些点。")
        elif len(triple) >= 3 and finite_number(triple[2]):
            z = float(triple[2])
        else:
            fail("界面点没有高程。请给出地面高程栅格，或用带高程的点。")
        formation = properties.get(contact_field)
        if formation is None or str(formation).strip() == "":
            fail(f"有界面点没有填 {contact_field}。")
        dip = properties.get(dip_field)
        azimuth = properties.get(azimuth_field)
        rows.append((x, y, z, str(formation).strip(), dip if finite_number(dip) else None, azimuth if finite_number(azimuth) else None))
    if len(rows) < 3:
        fail("界面点少于三个，撑不起地层体。")
    names = sorted({row[3] for row in rows})
    if len(names) < 2:
        fail("界面点只有一种地层，至少要两种。")
    oriented = [row for row in rows if row[4] is not None and row[5] is not None]
    if not oriented:
        fail("没有一个点同时有倾角和倾向。")
    for row in oriented:
        if not (0.0 <= float(row[4]) <= 90.0) or not (0.0 <= float(row[5]) <= 360.0):
            fail("倾角要在 0 到 90 度之间，倾向要在 0 到 360 度之间。")
    xs = numpy.array([row[0] for row in rows])
    ys = numpy.array([row[1] for row in rows])
    zs = numpy.array([row[2] for row in rows])
    if dem is not None:
        height, width = dem.shape
        minimum = numpy.array([dem_transform[0], dem_transform[3] + height * dem_transform[5], zs.min() - depth])
        maximum = numpy.array([dem_transform[0] + width * dem_transform[1], dem_transform[3], max(float(dem[dem_valid].max()), zs.max())])
    else:
        minimum = numpy.array([xs.min(), ys.min(), zs.min() - depth])
        maximum = numpy.array([xs.max(), ys.max(), zs.max()])
    if maximum[0] - minimum[0] <= 0 or maximum[1] - minimum[1] <= 0:
        fail("界面点在平面上排成一条线或重合，撑不起范围。请给高程栅格来定范围。")
    if maximum[2] - minimum[2] <= 0:
        fail("模型的竖向范围为零。")

    import pandas

    index_of = {name: index for index, name in enumerate(names)}
    records = []
    for x, y, z, formation, dip, azimuth in rows:
        records.append({"X": x, "Y": y, "Z": z, "feature_name": "strati", "interface": index_of[formation]})
    for x, y, z, formation, dip, azimuth in oriented:
        d = math.radians(float(dip))
        a = math.radians(float(azimuth))
        records.append({"X": x, "Y": y, "Z": z, "feature_name": "strati", "nx": math.sin(d) * math.sin(a), "ny": math.sin(d) * math.cos(a), "nz": math.cos(d)})
    frame = pandas.DataFrame(records)
    nx, ny, nz = GEOLOGY_GRID
    step = (maximum - minimum) / numpy.array([nx, ny, nz])
    gx = minimum[0] + (numpy.arange(nx) + 0.5) * step[0]
    gy = minimum[1] + (numpy.arange(ny) + 0.5) * step[1]
    gz = minimum[2] + (numpy.arange(nz) + 0.5) * step[2]
    zz, yy, xx = numpy.meshgrid(gz, gy, gx, indexing="ij")
    centers = numpy.column_stack([xx.ravel(), yy.ravel(), zz.ravel()])
    with quiet():
        from LoopStructural import GeologicalModel

        model = GeologicalModel(minimum, maximum)
        model.data = frame
        model.create_and_add_foliation("strati", interpolatortype="FDI", nelements=20000)
        model.update()
        at_points = model.evaluate_feature_value("strati", numpy.column_stack([xs, ys, zs]))
        field = model.evaluate_feature_value("strati", centers)
    if not numpy.all(numpy.isfinite(at_points)) or not numpy.all(numpy.isfinite(field)):
        fail("LoopStructural 没有给出有效的标量场。")
    levels = []
    for name in names:
        chosen = numpy.array([row[3] == name for row in rows])
        levels.append((float(numpy.mean(at_points[chosen])), name))
    levels.sort()
    ordered_values = numpy.array([value for value, _ in levels])
    unit = numpy.searchsorted(ordered_values, field, side="right")
    above = numpy.zeros(field.shape, dtype=bool)
    if dem is not None:
        ground = numpy.array([gb.sample_raster(dem, dem_valid, dem_transform, float(x), float(y)) for x, y in zip(centers[:, 0], centers[:, 1])], dtype=object)
        above = numpy.array([g is None or z > g for g, z in zip(ground, centers[:, 2])])
    unit = numpy.where(above, -1, unit)
    unit_names = ["底部以下"] + [name for _, name in levels]
    cell_volume = float(step[0] * step[1] * step[2])
    volumes = [float(numpy.count_nonzero(unit == index) * cell_volume) for index in range(len(unit_names))]
    model_file = gb.output_path(request, "-geology.json")
    with open(model_file, "w", encoding="utf-8") as handle:
        json.dump({
            "grid": [nx, ny, nz],
            "origin": [float(minimum[0]), float(minimum[1]), float(minimum[2])],
            "step": [float(step[0]), float(step[1]), float(step[2])],
            "units": unit_names,
            "cells": [int(value) for value in unit.tolist()],
        }, handle)
    summary = {"kind": "geology", "units": unit_names, "volumes": volumes, "points": len(rows), "oriented": len(oriented)}
    ok(
        facts={"featureCount": len(rows)},
        message=f"LoopStructural 已用 {len(rows)} 个界面点、{len(oriented)} 个产状算出 {len(names)} 个界面。",
        outputs=[gb.relative(model_file), gb.relative(write_summary(request, "-geology-summary.json", summary))],
    )


CAPABILITIES = {
    "engine.landslide": engine_landslide,
    "engine.runoff": engine_runoff,
    "engine.geology": engine_geology,
}


def check():
    missing = []
    versions = {}
    with quiet():
        try:
            import anuga

            versions["anuga"] = getattr(anuga, "__version__", "?")
        except Exception as error:
            missing.append(f"ANUGA（{type(error).__name__}）")
        try:
            import LoopStructural

            versions["LoopStructural"] = getattr(LoopStructural, "__version__", "?")
        except Exception as error:
            missing.append(f"LoopStructural（{type(error).__name__}）")
    if os.path.isfile(trigrs_executable()):
        versions["TRIGRS"] = "2.1"
    else:
        missing.append("TRIGRS")
    text = "、".join(f"{name} {version}" for name, version in versions.items())
    if missing:
        print(json.dumps({"ok": False, "message": f"缺少 {'、'.join(missing)}。" + (f"已有 {text}。" if text else "")}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps({"ok": True, "message": f"计算引擎就绪：{text}。"}, ensure_ascii=False))


def main():
    if "--check" in sys.argv:
        check()
        return
    try:
        request = json.load(sys.stdin)
    except Exception:
        fail("请求不是合法 JSON。")
        return
    handler = CAPABILITIES.get(request.get("capability", ""))
    if handler is None:
        fail(f"未知计算引擎能力：{request.get('capability', '')}")
        return
    if not request.get("inputResources"):
        fail("缺少输入资源。")
        return
    try:
        handler(request)
    except SystemExit:
        raise
    except Exception as error:
        fail(f"{type(error).__name__}: {error}")


if __name__ == "__main__":
    main()
