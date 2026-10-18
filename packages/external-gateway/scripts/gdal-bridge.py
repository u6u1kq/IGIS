#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""GDAL 薄封装桥（V0.88-T3）：stdin 收 JSON 请求，stdout 出 JSON 结果。

只在本地进程内持有路径与坐标；输出 facts 由 Node 侧外部能力边界再过一次白名单投影。
依赖：Python 3.11+ 与 GDAL Python 绑定（osgeo）。请求里的 inputResources 是相对
IGIS_BACKEND_ROOT 的资源标识，不是模型可见面。
"""

import json
import os
import sys

# Node 按 UTF-8 读管道。Windows 上 Python 管道默认是系统代码页，中文消息会变成乱码。
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure is not None:
        _reconfigure(encoding="utf-8")

# conda 环境未激活时，numpy 的 BLAS/LAPACK 是延迟加载的，只按进程 PATH 找 Library\bin 下的 DLL。
if os.name == "nt":
    _library_bin = os.path.join(sys.prefix, "Library", "bin")
    if os.path.isdir(_library_bin) and _library_bin.lower() not in os.environ.get("PATH", "").lower().split(os.pathsep):
        os.environ["PATH"] = _library_bin + os.pathsep + os.environ.get("PATH", "")


def ok(facts=None, message="", outputs=None):
    result = {"ok": True, "facts": facts or {}, "message": message}
    if outputs:
        result["outputResources"] = outputs
    print(json.dumps(result, ensure_ascii=False))


def fail(message):
    print(json.dumps({"ok": False, "message": message}, ensure_ascii=False))
    sys.exit(0)


def resolve_resource(resource):
    root = os.environ.get("IGIS_BACKEND_ROOT", os.getcwd())
    return os.path.join(root, resource)


def relative(path):
    root = os.environ.get("IGIS_BACKEND_ROOT", os.getcwd())
    return os.path.relpath(path, root).replace("\\", "/")


def output_path(request, suffix):
    hint = request.get("outputHint") or "derived"
    safe = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "-_") else "_" for ch in hint)[:40].strip("_") or "derived"
    directory = os.path.join(os.environ.get("IGIS_BACKEND_ROOT", os.getcwd()), "var", "backends")
    os.makedirs(directory, exist_ok=True)
    stamp = str(int(__import__("time").time() * 1000))
    return os.path.join(directory, f"{safe}-{stamp}{suffix}")


def vector_make_valid(request):
    from osgeo import ogr, gdal

    gdal.UseExceptions()
    source = resolve_resource(request["inputResources"][0])
    destination = output_path(request, ".geojson")
    src_ds = ogr.Open(source)
    if src_ds is None:
        fail("无法打开源数据。")
    src_layer = src_ds.GetLayer(0)
    driver = ogr.GetDriverByName("GeoJSON")
    dst_ds = driver.CreateDataSource(destination)
    dst_layer = dst_ds.CreateLayer(src_layer.GetName(), src_layer.GetSpatialRef(), src_layer.GetGeomType())
    definition = src_layer.GetLayerDefn()
    for index in range(definition.GetFieldCount()):
        dst_layer.CreateField(definition.GetFieldDefn(index))
    fixed = 0
    for feature in src_layer:
        geometry = feature.GetGeometryRef()
        if geometry is not None and not geometry.IsValid():
            valid = geometry.MakeValid()
            if valid is not None:
                feature.SetGeometry(valid)
                fixed += 1
        dst_layer.CreateFeature(feature)
    dst_ds = None
    src_ds = None
    ok(facts={"featureCount": fixed}, message=f"修复完成，修正 {fixed} 个几何。", outputs=[relative(destination)])


def vector_reproject(request):
    from osgeo import ogr, osr, gdal

    gdal.UseExceptions()
    source = resolve_resource(request["inputResources"][0])
    target_crs = str(request["parameters"].get("targetCrs") or "").strip()
    if not target_crs:
        fail("缺少目标坐标系。")
    destination = output_path(request, ".geojson")
    src_ds = ogr.Open(source)
    if src_ds is None:
        fail("无法打开源数据。")
    src_layer = src_ds.GetLayer(0)
    source_srs = src_layer.GetSpatialRef()
    if source_srs is None:
        fail("源图层没有坐标系定义，不能安全重投影。")
    target_srs = osr.SpatialReference()
    if target_srs.SetFromUserInput(target_crs) != 0:
        fail("无法解析目标坐标系。")
    if hasattr(source_srs, "SetAxisMappingStrategy"):
        source_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        target_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(source_srs, target_srs)
    driver = ogr.GetDriverByName("GeoJSON")
    dst_ds = driver.CreateDataSource(destination)
    dst_layer = dst_ds.CreateLayer(src_layer.GetName(), target_srs, src_layer.GetGeomType())
    definition = src_layer.GetLayerDefn()
    for index in range(definition.GetFieldCount()):
        dst_layer.CreateField(definition.GetFieldDefn(index))
    count = 0
    for feature in src_layer:
        geometry = feature.GetGeometryRef()
        if geometry is not None:
            geometry.Transform(transform)
            feature.SetGeometry(geometry)
        dst_layer.CreateFeature(feature)
        count += 1
    dst_ds = None
    src_ds = None
    ok(facts={"featureCount": count}, message="重投影完成。", outputs=[relative(destination)])


def vector_convert_format(request):
    from osgeo import ogr, gdal

    gdal.UseExceptions()
    source = resolve_resource(request["inputResources"][0])
    fmt = str(request["parameters"].get("format") or "gpkg").lower()
    drivers = {"gpkg": "GPKG", "geojson": "GeoJSON", "kml": "KML", "gml": "GML", "shp": "ESRI Shapefile"}
    driver_name = drivers.get(fmt)
    if driver_name is None:
        fail("不支持的目标格式。")
    suffix = f".{fmt}" if fmt != "shp" else ".shp"
    destination = output_path(request, suffix)
    src_ds = ogr.Open(source)
    if src_ds is None:
        fail("无法打开源数据。")
    driver = ogr.GetDriverByName(driver_name)
    driver.CopyDataSource(src_ds, destination)
    src_ds = None
    ok(facts={"format": fmt}, message="格式转换完成。", outputs=[relative(destination)])


CAPABILITIES = {
    "vector.makeValid": vector_make_valid,
    "vector.reproject": vector_reproject,
    "vector.convertFormat": vector_convert_format,
}


def raster_info(request):
    from osgeo import gdal

    gdal.UseExceptions()
    source = resolve_resource(request["inputResources"][0])
    dataset = gdal.Open(source)
    if dataset is None:
        fail("无法打开栅格。")
    band = dataset.GetRasterBand(1)
    statistics = band.GetStatistics(True, True)
    ok(
        facts={
            "width": dataset.RasterXSize,
            "height": dataset.RasterYSize,
            "bands": dataset.RasterCount,
            "minimum": round(statistics[0], 6),
            "maximum": round(statistics[1], 6),
            "mean": round(statistics[2], 6),
        },
        message="栅格元数据与统计已读取。",
    )


def raster_calc(request):
    from osgeo import gdal
    import numpy

    gdal.UseExceptions()
    allowed = {"add", "subtract", "multiply", "divide", "min", "max"}
    op = str(request["parameters"].get("op") or "").strip().lower()
    if op not in allowed:
        fail("不支持的栅格运算。")
    sources = request["inputResources"]
    if len(sources) < 2:
        fail("栅格运算需要两个栅格。")
    left = gdal.Open(resolve_resource(sources[0]))
    right = gdal.Open(resolve_resource(sources[1]))
    if left is None or right is None:
        fail("无法打开栅格。")
    band_a = left.GetRasterBand(1).ReadAsArray().astype("float64")
    band_b = right.GetRasterBand(1).ReadAsArray().astype("float64")
    if band_a.shape != band_b.shape:
        fail("两个栅格尺寸不一致。")
    with numpy.errstate(divide="ignore", invalid="ignore"):
        if op == "add":
            result = band_a + band_b
        elif op == "subtract":
            result = band_a - band_b
        elif op == "multiply":
            result = band_a * band_b
        elif op == "divide":
            result = numpy.divide(band_a, band_b)
        elif op == "min":
            result = numpy.minimum(band_a, band_b)
        else:
            result = numpy.maximum(band_a, band_b)
    destination = output_path(request, ".tif")
    driver = gdal.GetDriverByName("GTiff")
    dataset = driver.Create(destination, left.RasterXSize, left.RasterYSize, 1, gdal.GDT_Float64)
    dataset.SetGeoTransform(left.GetGeoTransform())
    dataset.SetProjection(left.GetProjection())
    dataset.GetRasterBand(1).WriteArray(result)
    dataset.FlushCache()
    dataset = None
    ok(facts={"op": op}, message="栅格运算完成。", outputs=[relative(destination)])


def dem_derivative(request):
    from osgeo import gdal

    gdal.UseExceptions()
    derivative = str(request["parameters"].get("derivative") or "").strip().lower()
    if derivative not in {"slope", "aspect", "hillshade"}:
        fail("DEM 衍生只支持 slope、aspect、hillshade。")
    source = resolve_resource(request["inputResources"][0])
    if gdal.Open(source) is None:
        fail("无法打开栅格。")
    destination = output_path(request, ".tif")
    gdal.DEMProcessing(destination, source, processing=derivative)
    ok(facts={"derivative": derivative}, message=f"{derivative} 完成。", outputs=[relative(destination)])


def contour(request):
    from osgeo import gdal, ogr

    gdal.UseExceptions()
    interval = request["parameters"].get("interval")
    if not isinstance(interval, (int, float)) or interval <= 0:
        fail("等高距必须大于 0。")
    source = resolve_resource(request["inputResources"][0])
    dataset = gdal.Open(source)
    if dataset is None:
        fail("无法打开栅格。")
    destination = output_path(request, ".geojson")
    driver = ogr.GetDriverByName("GeoJSON")
    datasource = driver.CreateDataSource(destination)
    srs = dataset.GetProjectionRef()
    layer = datasource.CreateLayer("contour", srs, ogr.wkbLineString)
    layer.CreateField(ogr.FieldDefn("elev", ogr.OFTReal))
    gdal.ContourGenerate(dataset.GetRasterBand(1), float(interval), 0, [], -1, 0, layer, 0, [])
    count = layer.GetFeatureCount()
    datasource = None
    ok(facts={"featureCount": count}, message=f"生成 {count} 条等高线。", outputs=[relative(destination)])


def write_raster(source, array, destination, data_type, nodata):
    from osgeo import gdal

    driver = gdal.GetDriverByName("GTiff")
    dataset = driver.Create(destination, source.RasterXSize, source.RasterYSize, 1, data_type)
    dataset.SetGeoTransform(source.GetGeoTransform())
    dataset.SetProjection(source.GetProjection())
    band = dataset.GetRasterBand(1)
    if nodata is not None:
        band.SetNoDataValue(float(nodata))
    band.WriteArray(array)
    dataset.FlushCache()
    dataset = None


def raster_cast(request):
    from osgeo import gdal

    gdal.UseExceptions()
    kind = str(request["parameters"].get("outputType") or "").strip().lower()
    types = {"int16": gdal.GDT_Int16, "int32": gdal.GDT_Int32, "float32": gdal.GDT_Float32}
    if kind not in types:
        fail("栅格类型只支持 int16、int32、float32。")
    source_path = resolve_resource(request["inputResources"][0])
    source = gdal.Open(source_path)
    if source is None:
        fail("无法打开栅格。")
    destination = output_path(request, ".tif")
    gdal.Translate(destination, source, format="GTiff", outputType=types[kind])
    source = None
    ok(facts={"target": kind}, message=f"已转为 {kind}。", outputs=[relative(destination)])


def raster_nodata(request):
    from osgeo import gdal

    gdal.UseExceptions()
    value = request["parameters"].get("noData")
    if not isinstance(value, (int, float)) or value != value or value in (float("inf"), float("-inf")):
        fail("NoData 必须是有限数值。")
    source_path = resolve_resource(request["inputResources"][0])
    source = gdal.Open(source_path)
    if source is None:
        fail("无法打开栅格。")
    destination = output_path(request, ".tif")
    gdal.Translate(destination, source, format="GTiff")
    source = None
    dataset = gdal.Open(destination, gdal.GA_Update)
    if dataset is None:
        fail("无法写入栅格。")
    dataset.GetRasterBand(1).SetNoDataValue(float(value))
    dataset.FlushCache()
    dataset = None
    ok(facts={"noData": float(value)}, message="已设置 NoData。像元值没有改。", outputs=[relative(destination)])


def raster_smooth(request):
    from osgeo import gdal
    import numpy

    gdal.UseExceptions()
    source_path = resolve_resource(request["inputResources"][0])
    source = gdal.Open(source_path)
    if source is None:
        fail("无法打开栅格。")
    band = source.GetRasterBand(1)
    array = band.ReadAsArray().astype("float64")
    nodata = band.GetNoDataValue()
    valid = numpy.isfinite(array)
    if nodata is not None:
        valid = valid & (array != float(nodata))
    values = numpy.where(valid, array, 0.0)
    height, width = array.shape
    padded_values = numpy.pad(values, 1, mode="constant", constant_values=0)
    padded_count = numpy.pad(valid.astype("float64"), 1, mode="constant", constant_values=0)
    total = numpy.zeros(array.shape, dtype="float64")
    count = numpy.zeros(array.shape, dtype="float64")
    for row in range(3):
        for column in range(3):
            total += padded_values[row:row + height, column:column + width]
            count += padded_count[row:row + height, column:column + width]
    fill = -9999.0 if nodata is None else float(nodata)
    result = numpy.divide(total, count, out=numpy.full(array.shape, fill, dtype="float64"), where=count > 0)
    destination = output_path(request, ".tif")
    write_raster(source, result.astype("float32"), destination, gdal.GDT_Float32, fill)
    source = None
    ok(facts={"width": int(width), "height": int(height)}, message="3×3 均值平滑完成。NoData 不参与平均。", outputs=[relative(destination)])


def raster_grid(request):
    from osgeo import gdal, ogr
    import numpy

    gdal.UseExceptions()
    field = str(request["parameters"].get("field") or "").strip()
    algorithm = str(request["parameters"].get("algorithm") or "").strip().lower()
    algorithms = {
        "invdist": "invdist:power=2.0:smoothing=0.0:radius1=0.0:radius2=0.0:angle=0.0:max_points=12:min_points=0:nodata=-9999.0",
        "nearest": "nearest:radius1=0.0:radius2=0.0:angle=0.0:nodata=-9999.0",
        "linear": "linear:radius=-1.0:nodata=-9999.0",
    }
    if algorithm not in algorithms:
        fail("插值只支持 invdist、nearest、linear。")
    if field == "":
        fail("插值需要字段名。")
    source = ogr.Open(resolve_resource(request["inputResources"][0]))
    if source is None:
        fail("无法打开点图层。")
    layer = source.GetLayer(0)
    if layer.GetLayerDefn().GetFieldIndex(field) < 0:
        fail(f"没有字段 {field}。")
    samples = []
    for feature in layer:
        geometry = feature.GetGeometryRef()
        if geometry is None or ogr.GT_Flatten(geometry.GetGeometryType()) != ogr.wkbPoint:
            continue
        raw = feature.GetField(field)
        if not isinstance(raw, (int, float)) or raw != raw or raw in (float("inf"), float("-inf")):
            continue
        samples.append((float(geometry.GetX()), float(geometry.GetY()), float(raw)))
    source = None
    if len(samples) < 3:
        fail("至少需要 3 个带数值的点。")
    held_index = {index for index in range(len(samples)) if index % 5 == 0} if len(samples) >= 5 else set()
    training = [sample for index, sample in enumerate(samples) if index not in held_index]
    held = [sample for index, sample in enumerate(samples) if index in held_index]
    if len(training) < 3:
        training = samples
        held = []
    xs = [sample[0] for sample in samples]
    ys = [sample[1] for sample in samples]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span_x = max_x - min_x
    span_y = max_y - min_y
    if span_x == 0 or span_y == 0:
        fail("点没有铺开，不能插成面。")
    min_x -= span_x * 0.05
    max_x += span_x * 0.05
    min_y -= span_y * 0.05
    max_y += span_y * 0.05
    longer = max(max_x - min_x, max_y - min_y)
    cell = longer / 200
    width = max(2, min(512, int(round((max_x - min_x) / cell))))
    height = max(2, min(512, int(round((max_y - min_y) / cell))))
    train_path = output_path(request, "-train.geojson")
    with open(train_path, "w", encoding="utf-8") as handle:
        json.dump({
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "properties": {field: sample[2]},
                "geometry": {"type": "Point", "coordinates": [sample[0], sample[1]]},
            } for sample in training],
        }, handle)
    destination = output_path(request, ".tif")
    options = gdal.GridOptions(
        format="GTiff",
        algorithm=algorithms[algorithm],
        zfield=field,
        width=width,
        height=height,
        outputBounds=[min_x, max_y, max_x, min_y],
        noData=-9999,
        outputType=gdal.GDT_Float32,
    )
    grid = gdal.Grid(destination, train_path, options=options)
    if grid is None:
        fail("插值没有生成栅格。")
    band = grid.GetRasterBand(1)
    transform = grid.GetGeoTransform()
    errors = []
    for sample_x, sample_y, sample_z in held:
        if transform[1] == 0 or transform[5] == 0:
            continue
        column = int((sample_x - transform[0]) / transform[1])
        row = int((sample_y - transform[3]) / transform[5])
        if column < 0 or row < 0 or column >= grid.RasterXSize or row >= grid.RasterYSize:
            continue
        predicted = float(band.ReadAsArray(column, row, 1, 1)[0][0])
        if predicted == -9999 or predicted != predicted:
            continue
        errors.append(predicted - sample_z)
    grid = None
    facts = {"featureCount": len(training), "heldOut": len(errors), "target": algorithm}
    if errors:
        values = numpy.array(errors, dtype="float64")
        facts["rmse"] = round(float(numpy.sqrt(numpy.mean(values * values))), 6)
        facts["mae"] = round(float(numpy.mean(numpy.abs(values))), 6)
    message = "插值完成。" if errors else "点数不足，没有做留出检验。"
    ok(facts=facts, message=message, outputs=[relative(destination)])


def read_features(resource):
    """图层文件按 JSON 读，坐标原样使用，不经过 OGR 的 GeoJSON 坐标系假设。"""
    with open(resolve_resource(resource), "r", encoding="utf-8") as handle:
        data = json.load(handle)
    features = data.get("features") if isinstance(data, dict) else None
    if not isinstance(features, list):
        fail("图层文件不是要素集合。")
    return [feature for feature in features if isinstance(feature, dict)]


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and value not in (float("inf"), float("-inf"))


def first_point(resource, label):
    for feature in read_features(resource):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            continue
        pair = geometry.get("coordinates") or []
        if len(pair) >= 2 and finite_number(pair[0]) and finite_number(pair[1]):
            return float(pair[0]), float(pair[1])
    fail(f"{label}需要一个点。")


def polygons_as_layer(resource, request, suffix, projection_wkt):
    """把面写成 GPKG 并声明与栅格同一坐标系。坐标不变，只避免 GDAL 把它当作 WGS84 再变换。"""
    from osgeo import ogr, osr

    srs = None
    if projection_wkt:
        srs = osr.SpatialReference()
        srs.ImportFromWkt(projection_wkt)
        srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    destination = output_path(request, suffix + ".gpkg")
    datasource = ogr.GetDriverByName("GPKG").CreateDataSource(destination)
    layer = datasource.CreateLayer("zones", srs, ogr.wkbUnknown)
    layer.CreateField(ogr.FieldDefn("zone", ogr.OFTInteger))
    zone = 0
    for feature in read_features(resource):
        geometry = feature.get("geometry")
        if not isinstance(geometry, dict) or geometry.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        created_geometry = ogr.CreateGeometryFromJson(json.dumps(geometry))
        if created_geometry is None:
            continue
        zone += 1
        created = ogr.Feature(layer.GetLayerDefn())
        created.SetGeometry(created_geometry)
        created.SetField("zone", zone)
        layer.CreateFeature(created)
    datasource = None
    if zone == 0:
        fail("没有可用的面。")
    return destination, zone


def check_layer_crs(dataset, request):
    """图层是已知 EPSG 且栅格声明了坐标系时，两者必须相同。没有声明的一方不比对。"""
    from osgeo import osr

    epsg = request["parameters"].get("layerEpsg")
    projection = dataset.GetProjection()
    if not finite_number(epsg) or not projection:
        return
    layer_srs = osr.SpatialReference()
    if layer_srs.ImportFromEPSG(int(epsg)) != 0:
        fail("图层坐标系代码无法识别。")
    raster_srs = osr.SpatialReference()
    raster_srs.ImportFromWkt(projection)
    if not raster_srs.IsSame(layer_srs, ["IGNORE_DATA_AXIS_TO_SRS_AXIS_MAPPING=YES", "CRITERION=EQUIVALENT_EXCEPT_AXIS_ORDER_GEOGCRS"]):
        fail("图层和栅格的坐标系不同。请先把图层用 map.reproject 转到栅格的坐标系。")


def valid_mask(array, nodata):
    import numpy

    mask = numpy.isfinite(array)
    if nodata is not None:
        mask = mask & (array != float(nodata))
    return mask


def raster_viewshed(request):
    from osgeo import gdal

    gdal.UseExceptions()
    sources = request["inputResources"]
    if len(sources) < 2:
        fail("可视域需要栅格和观察点图层。")
    height = request["parameters"].get("observerHeight")
    if not finite_number(height) or height < 0:
        fail("观察点高度必须大于或等于 0。")
    x, y = first_point(sources[1], "可视域")
    dataset = gdal.Open(resolve_resource(sources[0]))
    if dataset is None:
        fail("无法打开栅格。")
    check_layer_crs(dataset, request)
    transform = dataset.GetGeoTransform()
    column = (x - transform[0]) / transform[1]
    row = (y - transform[3]) / transform[5]
    if column < 0 or row < 0 or column >= dataset.RasterXSize or row >= dataset.RasterYSize:
        fail("观察点不在栅格范围内。")
    destination = output_path(request, ".tif")
    gdal.ViewshedGenerate(
        dataset.GetRasterBand(1),
        "GTiff",
        destination,
        [],
        float(x),
        float(y),
        float(height),
        0,
        255,
        0,
        0,
        0,
        1,
        gdal.GVM_Edge,
        0,
    )
    dataset = None
    import numpy

    result = gdal.Open(destination)
    visible = int(numpy.count_nonzero(result.GetRasterBand(1).ReadAsArray() == 255))
    result = None
    ok(facts={"observerHeight": float(height), "featureCount": visible}, message=f"可视域完成。可见像元为 255，共 {visible} 个。", outputs=[relative(destination)])


def raster_clip(request):
    from osgeo import gdal

    gdal.UseExceptions()
    sources = request["inputResources"]
    if len(sources) < 2:
        fail("裁剪栅格需要栅格和面。")
    raster_path = resolve_resource(sources[0])
    source = gdal.Open(raster_path)
    if source is None:
        fail("无法打开栅格。")
    check_layer_crs(source, request)
    nodata = source.GetRasterBand(1).GetNoDataValue()
    cutline, _ = polygons_as_layer(sources[1], request, "-cut", source.GetProjection())
    source = None
    destination = output_path(request, ".tif")
    gdal.Warp(destination, raster_path, format="GTiff", cutlineDSName=cutline, cropToCutline=True, dstNodata=-9999.0 if nodata is None else float(nodata))
    clipped = gdal.Open(destination)
    width, height = clipped.RasterXSize, clipped.RasterYSize
    clipped = None
    ok(facts={"width": int(width), "height": int(height)}, message=f"栅格已按面裁剪，{width}×{height}。", outputs=[relative(destination)])


def raster_polygonize(request):
    from osgeo import gdal, ogr

    gdal.UseExceptions()
    source = gdal.Open(resolve_resource(request["inputResources"][0]))
    if source is None:
        fail("无法打开栅格。")
    band = source.GetRasterBand(1)
    destination = output_path(request, ".geojson")
    driver = ogr.GetDriverByName("GeoJSON")
    datasource = driver.CreateDataSource(destination)
    # 面沿用栅格坐标系；非 WGS84 时 GeoJSON 写出 crs 成员，载入时据此识别。
    layer = datasource.CreateLayer("zone", srs=source.GetSpatialRef(), geom_type=ogr.wkbPolygon)
    field = ogr.FieldDefn("value", ogr.OFTReal)
    layer.CreateField(field)
    gdal.Polygonize(band, band.GetMaskBand(), layer, 0, [], callback=None)
    count = layer.GetFeatureCount()
    datasource = None
    source = None
    ok(facts={"featureCount": count}, message=f"栅格转面完成，{count} 个面。NoData 像元不出面。", outputs=[relative(destination)])


def raster_rasterize(request):
    import math
    from osgeo import gdal, ogr

    gdal.UseExceptions()
    cell = request["parameters"].get("cellSize")
    if not finite_number(cell) or cell <= 0:
        fail("格网边长必须大于 0。")
    projection = ""
    epsg = request["parameters"].get("layerEpsg")
    if finite_number(epsg):
        from osgeo import osr

        srs = osr.SpatialReference()
        if srs.ImportFromEPSG(int(epsg)) != 0:
            fail("图层坐标系代码无法识别。")
        projection = srs.ExportToWkt()
    zones_path, _ = polygons_as_layer(request["inputResources"][0], request, "-zones", projection)
    datasource = ogr.Open(zones_path)
    layer = datasource.GetLayer(0)
    extent = layer.GetExtent()
    width = max(1, int(math.ceil((extent[1] - extent[0]) / float(cell) - 1e-9)))
    height = max(1, int(math.ceil((extent[3] - extent[2]) / float(cell) - 1e-9)))
    if width * height > 4000000:
        fail("栅格太大。请加大边长。")
    destination = output_path(request, ".tif")
    driver = gdal.GetDriverByName("GTiff")
    dataset = driver.Create(destination, width, height, 1, gdal.GDT_Float32)
    dataset.SetGeoTransform([extent[0], float(cell), 0, extent[3], 0, -float(cell)])
    if projection:
        dataset.SetProjection(projection)
    dataset.GetRasterBand(1).Fill(-9999)
    dataset.GetRasterBand(1).SetNoDataValue(-9999)
    gdal.RasterizeLayer(dataset, [1], layer, burn_values=[1])
    dataset.FlushCache()
    dataset = None
    datasource = None
    ok(facts={"width": width, "height": height}, message=f"面已转为栅格，{width}×{height}，面内为 1。", outputs=[relative(destination)])


def raster_zonal(request):
    from osgeo import gdal, ogr
    import numpy

    gdal.UseExceptions()
    sources = request["inputResources"]
    if len(sources) < 2:
        fail("按面统计需要栅格和面。")
    values_ds = gdal.Open(resolve_resource(sources[0]))
    if values_ds is None:
        fail("无法打开栅格。")
    check_layer_crs(values_ds, request)
    band = values_ds.GetRasterBand(1)
    values = band.ReadAsArray().astype("float64")
    valid = valid_mask(values, band.GetNoDataValue())
    zones_path, zone_count = polygons_as_layer(sources[1], request, "-zones", values_ds.GetProjection())
    ids_ds = gdal.GetDriverByName("MEM").Create("", values_ds.RasterXSize, values_ds.RasterYSize, 1, gdal.GDT_Int32)
    ids_ds.SetGeoTransform(values_ds.GetGeoTransform())
    ids_ds.SetProjection(values_ds.GetProjection())
    ids_ds.GetRasterBand(1).Fill(0)
    zones = ogr.Open(zones_path)
    gdal.RasterizeLayer(ids_ds, [1], zones.GetLayer(0), options=["ATTRIBUTE=zone"])
    zones = None
    ids = ids_ds.GetRasterBand(1).ReadAsArray()
    ids_ds = None
    values_ds = None
    rows = []
    means = []
    for zone in range(1, zone_count + 1):
        picked = values[(ids == zone) & valid]
        if picked.size == 0:
            rows.append(f"面 {zone}: 没有有效像元")
            continue
        means.append(float(picked.mean()))
        rows.append(f"面 {zone}: 像元 {picked.size}，最小 {float(picked.min()):.6g}，最大 {float(picked.max()):.6g}，平均 {float(picked.mean()):.6g}，总和 {float(picked.sum()):.6g}")
    if not means:
        fail("面里没有有效像元。")
    ok(facts={"featureCount": zone_count}, message="按面统计完成。面按图层顺序编号。" + "；".join(rows[:30]), outputs=[])


def vector_offset(request):
    from osgeo import osr
    from shapely.geometry import mapping, shape

    parameters = request["parameters"]
    distance = parameters.get("distance")
    join = str(parameters.get("join") or "round").strip().lower()
    if not finite_number(distance) or distance == 0:
        fail("平行线距离必须是非零数值。")
    if join not in ("round", "mitre", "bevel"):
        fail("拐角只支持 round、mitre、bevel。")
    epsg = parameters.get("epsg")
    unit_to_meter = parameters.get("unitToMeter")
    factor = 1.0
    unit = "坐标单位"
    if finite_number(epsg) and epsg > 0:
        srs = osr.SpatialReference()
        if srs.ImportFromEPSG(int(epsg)) != 0:
            fail("坐标系代码无法识别。")
        if srs.IsGeographic():
            fail("平行线需要投影坐标。请先用 map.reproject 转到投影坐标系。")
        factor = float(srs.GetLinearUnits())
        unit = "米"
    elif finite_number(unit_to_meter) and unit_to_meter > 0:
        factor = float(unit_to_meter)
        unit = "米"
    offset = float(distance) / factor
    output = []
    for feature in read_features(request["inputResources"][0]):
        geometry = feature.get("geometry")
        if not isinstance(geometry, dict) or geometry.get("type") not in ("LineString", "MultiLineString"):
            continue
        source = shape(geometry)
        parts = [source] if source.geom_type == "LineString" else list(source.geoms)
        for part in parts:
            if part.is_empty or part.length == 0:
                continue
            curve = part.offset_curve(offset, quad_segs=16, join_style=join, mitre_limit=5.0)
            if curve.is_empty:
                continue
            properties = dict(feature.get("properties") or {})
            properties["_offset"] = float(distance)
            output.append({"type": "Feature", "properties": properties, "geometry": mapping(curve)})
    if not output:
        fail("没有线可以生成平行线。")
    destination = output_path(request, ".geojson")
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": output}, handle, ensure_ascii=False)
    side = "左" if distance > 0 else "右"
    ok(facts={"featureCount": len(output), "distance": float(distance)}, message=f"在线的{side}侧生成 {len(output)} 条平行线，距离 {abs(float(distance))} {unit}，拐角 {join}。", outputs=[relative(destination)])


def cell_of(transform, width, height, x, y, label):
    column = int((x - transform[0]) // transform[1])
    row = int((y - transform[3]) // transform[5])
    if column < 0 or row < 0 or column >= width or row >= height:
        fail(f"{label}不在栅格范围内。")
    return row, column


def accumulate_cost(cost, start, step_x, step_y):
    """8 邻域 Dijkstra。一步的费用 = 两端像元费用均值 × 步长；inf 表示不可通行。"""
    import heapq
    import math
    import numpy

    height, width = cost.shape
    flat = cost.ravel()
    total = numpy.full(height * width, numpy.inf)
    previous = numpy.full(height * width, -1, dtype="int64")
    diagonal = math.hypot(step_x, step_y)
    moves = [(-1, -1, diagonal), (-1, 0, step_y), (-1, 1, diagonal), (0, -1, step_x), (0, 1, step_x), (1, -1, diagonal), (1, 0, step_y), (1, 1, diagonal)]
    origin = start[0] * width + start[1]
    total[origin] = 0.0
    queue = [(0.0, origin)]
    while queue:
        current, index = heapq.heappop(queue)
        if current > total[index]:
            continue
        row, column = divmod(index, width)
        here = flat[index]
        for d_row, d_column, length in moves:
            next_row = row + d_row
            next_column = column + d_column
            if next_row < 0 or next_column < 0 or next_row >= height or next_column >= width:
                continue
            neighbor = next_row * width + next_column
            there = flat[neighbor]
            if there == numpy.inf:
                continue
            candidate = current + (here + there) * 0.5 * length
            if candidate < total[neighbor]:
                total[neighbor] = candidate
                previous[neighbor] = index
                heapq.heappush(queue, (candidate, neighbor))
    return total.reshape(height, width), previous


def raster_cost_corridor(request):
    from osgeo import gdal
    import numpy

    gdal.UseExceptions()
    sources = request["inputResources"]
    if len(sources) < 3:
        fail("最小费用走廊需要费用栅格、起点图层和终点图层。")
    tolerance = request["parameters"].get("tolerance")
    tolerance = 0.05 if tolerance is None else tolerance
    if not finite_number(tolerance) or tolerance < 0 or tolerance > 1:
        fail("走廊宽容度必须在 0 到 1 之间。")
    dataset = gdal.Open(resolve_resource(sources[0]))
    if dataset is None:
        fail("无法打开费用栅格。")
    band = dataset.GetRasterBand(1)
    width, height = dataset.RasterXSize, dataset.RasterYSize
    if width * height > 1000000:
        fail("费用栅格超过 100 万像元。请先重采样。")
    check_layer_crs(dataset, request)
    transform = dataset.GetGeoTransform()
    if transform[2] != 0 or transform[4] != 0:
        fail("费用栅格不能有旋转。")
    raw = band.ReadAsArray().astype("float64")
    passable = valid_mask(raw, band.GetNoDataValue()) & (raw > 0)
    cost = numpy.where(passable, raw, numpy.inf)
    start = cell_of(transform, width, height, *first_point(sources[1], "起点"), "起点")
    end = cell_of(transform, width, height, *first_point(sources[2], "终点"), "终点")
    if cost[start] == numpy.inf or cost[end] == numpy.inf:
        fail("起点或终点落在不可通行像元上。")
    step_x, step_y = abs(transform[1]), abs(transform[5])
    from_start, previous = accumulate_cost(cost, start, step_x, step_y)
    best = float(from_start[end])
    if best == numpy.inf:
        fail("起点到终点没有可通行路径。")
    from_end, _ = accumulate_cost(cost, end, step_x, step_y)
    through = from_start + from_end
    corridor = numpy.where(through <= best * (1 + tolerance) + 1e-9, through, -9999.0)
    raster_path = output_path(request, "-corridor.tif")
    write_raster(dataset, corridor.astype("float32"), raster_path, gdal.GDT_Float32, -9999.0)
    cells = []
    index = end[0] * width + end[1]
    origin = start[0] * width + start[1]
    while index != -1:
        cells.append(divmod(int(index), width))
        if index == origin:
            break
        index = int(previous[index])
    cells.reverse()
    line = [[transform[0] + (column + 0.5) * transform[1], transform[3] + (row + 0.5) * transform[5]] for row, column in cells]
    if len(line) == 1:
        line.append(list(line[0]))
    path_path = output_path(request, "-path.geojson")
    with open(path_path, "w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"_cost": best, "_cells": len(cells)}, "geometry": {"type": "LineString", "coordinates": line}}]}, handle)
    corridor_cells = int(numpy.count_nonzero(corridor != -9999.0))
    dataset = None
    ok(
        facts={"pathCost": round(best, 9), "featureCount": len(cells), "tolerance": float(tolerance)},
        message=f"最小费用路径经过 {len(cells)} 个像元，累计费用 {best:.6g}。走廊含 {corridor_cells} 个像元（累计费用不超过最小值的 {1 + tolerance:.3g} 倍）。NoData 和不大于 0 的像元不可通行。",
        outputs=[relative(raster_path), relative(path_path)],
    )


def standardize(train, other):
    import numpy

    mean = train.mean(axis=0)
    scale = train.std(axis=0)
    scale[scale == 0] = 1.0
    return (train - mean) / scale, [(item - mean) / scale for item in other]


def fit_classifier(name, features, labels, classes):
    import numpy

    if name == "mindist":
        return {"name": name, "means": numpy.array([features[labels == code].mean(axis=0) for code in classes])}
    if name == "maxlike":
        bands = features.shape[1]
        means = []
        inverses = []
        logdets = []
        for code in classes:
            picked = features[labels == code]
            mean = picked.mean(axis=0)
            if picked.shape[0] > 1:
                covariance = numpy.atleast_2d(numpy.cov(picked, rowvar=False))
            else:
                covariance = numpy.zeros((bands, bands))
            covariance = covariance + numpy.eye(bands) * (1e-6 * max(float(numpy.trace(covariance)) / bands, 1e-6))
            sign, logdet = numpy.linalg.slogdet(covariance)
            means.append(mean)
            inverses.append(numpy.linalg.inv(covariance))
            logdets.append(logdet)
        return {"name": name, "means": numpy.array(means), "inverses": inverses, "logdets": logdets}
    k = int(name[3:])
    return {"name": name, "k": k, "features": features, "labels": labels}


def predict_classifier(model, features, classes):
    import numpy

    classes = numpy.array(classes)
    if model["name"] == "mindist":
        distances = numpy.stack([((features - mean) ** 2).sum(axis=1) for mean in model["means"]], axis=1)
        return classes[numpy.argmin(distances, axis=1)]
    if model["name"] == "maxlike":
        scores = []
        for mean, inverse, logdet in zip(model["means"], model["inverses"], model["logdets"]):
            delta = features - mean
            scores.append(-0.5 * (logdet + numpy.einsum("ij,jk,ik->i", delta, inverse, delta)))
        return classes[numpy.argmax(numpy.array(scores), axis=0)]
    k = min(model["k"], model["features"].shape[0])
    result = numpy.empty(features.shape[0], dtype=classes.dtype)
    chunk_size = max(1, 4000000 // max(1, model["features"].shape[0] * features.shape[1]))
    for begin in range(0, features.shape[0], chunk_size):
        chunk = features[begin:begin + chunk_size]
        distances = ((chunk[:, None, :] - model["features"][None, :, :]) ** 2).sum(axis=2)
        if k < distances.shape[1]:
            nearest = numpy.argpartition(distances, k - 1, axis=1)[:, :k]
        else:
            nearest = numpy.tile(numpy.arange(distances.shape[1]), (chunk.shape[0], 1))
        order = numpy.argsort(numpy.take_along_axis(distances, nearest, axis=1), axis=1, kind="stable")
        nearest_labels = model["labels"][numpy.take_along_axis(nearest, order, axis=1)]
        # 票数多者胜；票数相同，最近邻所在的类胜。
        score = numpy.zeros((chunk.shape[0], classes.shape[0]))
        for position, code in enumerate(classes):
            hits = nearest_labels == code
            first = numpy.where(hits.any(axis=1), hits.argmax(axis=1), k)
            score[:, position] = hits.sum(axis=1) * (k + 1) - first
        result[begin:begin + chunk.shape[0]] = classes[numpy.argmax(score, axis=1)]
    return result


def stratified_folds(labels, folds, rng):
    import numpy

    assignment = numpy.empty(labels.shape[0], dtype="int64")
    for code in numpy.unique(labels):
        members = numpy.flatnonzero(labels == code)
        rng.shuffle(members)
        assignment[members] = numpy.arange(members.shape[0]) % folds
    return assignment


def raster_classify(request):
    from osgeo import gdal
    import numpy

    gdal.UseExceptions()
    sources = request["inputResources"]
    if len(sources) < 2:
        fail("监督分类需要栅格和训练点图层。")
    parameters = request["parameters"]
    field = str(parameters.get("field") or "").strip()
    method = str(parameters.get("method") or "auto").strip().lower()
    test_fraction = parameters.get("testFraction")
    test_fraction = 0.3 if test_fraction is None else test_fraction
    candidates = ["mindist", "maxlike", "knn1", "knn3", "knn5", "knn7"]
    if field == "":
        fail("监督分类需要类别字段。")
    if method != "auto" and method not in candidates:
        fail("分类方法只支持 auto、mindist、maxlike、knn1、knn3、knn5、knn7。")
    if not finite_number(test_fraction) or test_fraction <= 0 or test_fraction >= 0.9:
        fail("检验样本比例必须大于 0 且小于 0.9。")
    datasets = [gdal.Open(resolve_resource(resource)) for resource in sources[:-1]]
    if any(dataset is None for dataset in datasets):
        fail("无法打开栅格。")
    reference = datasets[0]
    width, height = reference.RasterXSize, reference.RasterYSize
    transform = reference.GetGeoTransform()
    check_layer_crs(reference, request)
    if width * height > 4000000:
        fail("栅格超过 400 万像元。请先重采样或裁剪。")
    stack = []
    valid = numpy.ones((height, width), dtype=bool)
    for dataset in datasets:
        if dataset.RasterXSize != width or dataset.RasterYSize != height or any(abs(a - b) > 1e-9 * max(1.0, abs(a)) for a, b in zip(dataset.GetGeoTransform(), transform)):
            fail("参与分类的栅格必须同一网格。请先重采样对齐。")
        for band_index in range(1, dataset.RasterCount + 1):
            band = dataset.GetRasterBand(band_index)
            array = band.ReadAsArray().astype("float64")
            valid &= valid_mask(array, band.GetNoDataValue())
            stack.append(array)
    if len(stack) > 32:
        fail("波段超过 32 个。")
    cube = numpy.stack(stack, axis=-1)
    samples = []
    names = []
    for feature in read_features(sources[-1]):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            continue
        pair = geometry.get("coordinates") or []
        raw = (feature.get("properties") or {}).get(field)
        if raw is None or isinstance(raw, bool) or len(pair) < 2 or not finite_number(pair[0]) or not finite_number(pair[1]):
            continue
        column = int((pair[0] - transform[0]) // transform[1])
        row = int((pair[1] - transform[3]) // transform[5])
        if column < 0 or row < 0 or column >= width or row >= height or not valid[row, column]:
            continue
        label = str(int(raw)) if isinstance(raw, float) and raw.is_integer() else str(raw)
        samples.append(cube[row, column])
        names.append(label)
    if len(samples) < 6:
        fail("落在有效像元上的训练点少于 6 个。")
    distinct = sorted(set(names))
    if len(distinct) < 2:
        fail("至少需要 2 个类别。")
    if all(name.isdigit() and 1 <= int(name) <= 65535 for name in distinct):
        code_of = {name: int(name) for name in distinct}
    else:
        code_of = {name: index + 1 for index, name in enumerate(distinct)}
    features = numpy.array(samples, dtype="float64")
    labels = numpy.array([code_of[name] for name in names], dtype="int64")
    classes = sorted(code_of.values())
    rng = numpy.random.default_rng(20261017)
    is_test = numpy.zeros(labels.shape[0], dtype=bool)
    for code in classes:
        members = numpy.flatnonzero(labels == code)
        rng.shuffle(members)
        count = int(round(members.shape[0] * test_fraction))
        if members.shape[0] >= 3:
            count = min(max(count, 1), members.shape[0] - 2)
        else:
            count = 0
        is_test[members[:count]] = True
    train_features, train_labels = features[~is_test], labels[~is_test]
    test_features, test_labels = features[is_test], labels[is_test]
    if any(numpy.count_nonzero(train_labels == code) == 0 for code in classes):
        fail("有类别没有训练样本。")
    smallest = min(int(numpy.count_nonzero(train_labels == code)) for code in classes)
    folds = min(5, smallest)
    scores = {}
    chosen = method
    if method == "auto":
        if folds < 2:
            chosen = "mindist"
        else:
            assignment = stratified_folds(train_labels, folds, rng)
            for name in candidates:
                if name.startswith("knn") and int(name[3:]) > train_labels.shape[0] - train_labels.shape[0] // folds:
                    continue
                correct = 0
                for fold in range(folds):
                    fit_mask = assignment != fold
                    fit_x, check_x = standardize(train_features[fit_mask], [train_features[~fit_mask]])
                    model = fit_classifier(name, fit_x, train_labels[fit_mask], classes)
                    correct += int(numpy.count_nonzero(predict_classifier(model, check_x[0], classes) == train_labels[~fit_mask]))
                scores[name] = correct / train_labels.shape[0]
            chosen = max(candidates, key=lambda name: (scores.get(name, -1.0), -candidates.index(name)))
    train_x, scaled = standardize(train_features, [test_features, cube[valid]])
    model = fit_classifier(chosen, train_x, train_labels, classes)
    facts = {"classifier": chosen, "featureCount": int(train_labels.shape[0]), "heldOut": int(test_labels.shape[0])}
    if chosen in scores:
        facts["cvAccuracy"] = round(scores[chosen], 6)
    message = [f"训练样本 {train_labels.shape[0]} 个，检验样本 {test_labels.shape[0]} 个，选用 {chosen}。"]
    if scores:
        message.append(f"{folds} 折交叉验证精度：" + "，".join(f"{name} {value:.4f}" for name, value in scores.items()) + "。")
    message.append("类别编码：" + "，".join(f"{name}={code_of[name]}" for name in distinct) + "。")
    if test_labels.shape[0] > 0:
        predicted = predict_classifier(model, scaled[0], classes)
        index_of = {code: position for position, code in enumerate(classes)}
        matrix = numpy.zeros((len(classes), len(classes)), dtype="int64")
        for truth, guess in zip(test_labels, predicted):
            matrix[index_of[int(truth)], index_of[int(guess)]] += 1
        total = float(matrix.sum())
        observed = float(numpy.trace(matrix)) / total
        expected = float((matrix.sum(axis=0) * matrix.sum(axis=1)).sum()) / (total * total)
        kappa = (observed - expected) / (1 - expected) if expected < 1 else 1.0
        facts["accuracy"] = round(observed, 6)
        facts["kappa"] = round(kappa, 6)
        facts["numbers"] = [int(value) for value in matrix.ravel()]
        rows = []
        for position, code in enumerate(classes):
            reference_total = int(matrix[position].sum())
            mapped_total = int(matrix[:, position].sum())
            producer = matrix[position, position] / reference_total if reference_total else float("nan")
            user = matrix[position, position] / mapped_total if mapped_total else float("nan")
            rows.append(f"类 {code} 生产者精度 {producer:.4f}，用户精度 {user:.4f}")
        message.append(f"检验总体精度 {observed:.4f}，Kappa {kappa:.4f}。混淆矩阵按行是参考类、按列是分类结果，类顺序 {'、'.join(str(code) for code in classes)}。" + "；".join(rows) + "。")
    else:
        message.append("样本太少，没有留出检验。")
    output = numpy.zeros((height, width), dtype="uint16")
    output[valid] = predict_classifier(model, scaled[1], classes).astype("uint16")
    destination = output_path(request, ".tif")
    write_raster(reference, output, destination, gdal.GDT_UInt16, 0)
    datasets = None
    reference = None
    ok(facts=facts, message="".join(message), outputs=[relative(destination)])


def raster_resample(request):
    from osgeo import gdal

    gdal.UseExceptions()
    cell = request["parameters"].get("cellSize")
    if not isinstance(cell, (int, float)) or cell <= 0:
        fail("格网边长必须大于 0。")
    destination = output_path(request, ".tif")
    gdal.Warp(destination, resolve_resource(request["inputResources"][0]), format="GTiff", xRes=float(cell), yRes=float(cell))
    ok(facts={"cellSize": float(cell)}, message="重采样完成。", outputs=[relative(destination)])


def raster_index(request):
    from osgeo import gdal
    import numpy

    gdal.UseExceptions()
    kind = str(request["parameters"].get("index") or "").strip().lower()
    if kind not in {"ndvi", "ndwi", "savi"}:
        fail("指数只支持 ndvi、ndwi、savi。")
    sources = request["inputResources"]
    if len(sources) < 2:
        fail("指数需要两个单波段栅格。")
    first = gdal.Open(resolve_resource(sources[0]))
    second = gdal.Open(resolve_resource(sources[1]))
    if first is None or second is None:
        fail("无法打开栅格。")
    first_band = first.GetRasterBand(1)
    second_band = second.GetRasterBand(1)
    a = first_band.ReadAsArray().astype("float64")
    b = second_band.ReadAsArray().astype("float64")
    if a.shape != b.shape or any(abs(x - y) > 1e-9 * max(1.0, abs(x)) for x, y in zip(first.GetGeoTransform(), second.GetGeoTransform())):
        fail("两个栅格不在同一网格。请先重采样对齐。")
    valid = valid_mask(a, first_band.GetNoDataValue()) & valid_mask(b, second_band.GetNoDataValue())
    denominator = a + b + 0.5 if kind == "savi" else a + b
    valid &= denominator != 0
    result = numpy.full(a.shape, -9999.0)
    if kind == "savi":
        result[valid] = (a[valid] - b[valid]) / denominator[valid] * 1.5
    else:
        result[valid] = (a[valid] - b[valid]) / denominator[valid]
    destination = output_path(request, ".tif")
    write_raster(first, result.astype("float32"), destination, gdal.GDT_Float32, -9999)
    first = None
    second = None
    roles = "第一个栅格是绿波段，第二个是近红外" if kind == "ndwi" else "第一个栅格是近红外，第二个是红波段"
    ok(facts={"target": kind}, message=f"{kind} 完成。{roles}。NoData 和分母为 0 的像元写为 -9999。", outputs=[relative(destination)])


def raster_focal(request):
    from osgeo import gdal
    import numpy

    gdal.UseExceptions()
    size = request["parameters"].get("size")
    if size not in (3, 5, 7):
        fail("邻域边长只支持 3、5、7。")
    source = gdal.Open(resolve_resource(request["inputResources"][0]))
    if source is None:
        fail("无法打开栅格。")
    band = source.GetRasterBand(1)
    array = band.ReadAsArray().astype("float64")
    nodata = band.GetNoDataValue()
    valid = numpy.isfinite(array)
    if nodata is not None:
        valid = valid & (array != float(nodata))
    values = numpy.where(valid, array, 0.0)
    radius = int(size) // 2
    padded_values = numpy.pad(values, radius, mode="constant", constant_values=0)
    padded_count = numpy.pad(valid.astype("float64"), radius, mode="constant", constant_values=0)
    total = numpy.zeros(array.shape, dtype="float64")
    count = numpy.zeros(array.shape, dtype="float64")
    window = int(size)
    for row in range(window):
        for column in range(window):
            total += padded_values[row:row + array.shape[0], column:column + array.shape[1]]
            count += padded_count[row:row + array.shape[0], column:column + array.shape[1]]
    fill = -9999.0 if nodata is None else float(nodata)
    result = numpy.divide(total, count, out=numpy.full(array.shape, fill, dtype="float64"), where=count > 0)
    destination = output_path(request, ".tif")
    write_raster(source, result.astype("float32"), destination, gdal.GDT_Float32, fill)
    source = None
    ok(facts={"size": int(size)}, message=f"{int(size)}×{int(size)} 邻域均值完成。", outputs=[relative(destination)])


def planar_unit(projection, label):
    """投影坐标返回每单位的米数；没有坐标系返回 None；地理坐标拒绝。"""
    from osgeo import osr

    if not projection:
        return None
    srs = osr.SpatialReference()
    srs.ImportFromWkt(projection)
    if srs.IsGeographic():
        fail(f"{label}需要投影坐标。请先把数据投影到以米为单位的坐标系。")
    return float(srs.GetLinearUnits())


def layer_projection(request):
    from osgeo import osr

    epsg = request["parameters"].get("layerEpsg")
    if not finite_number(epsg):
        return ""
    srs = osr.SpatialReference()
    if srs.ImportFromEPSG(int(epsg)) != 0:
        fail("图层坐标系代码无法识别。")
    return srs.ExportToWkt()


def unit_label(unit):
    if unit is None:
        return "坐标单位"
    return "米" if abs(unit - 1.0) < 1e-12 else "投影单位"


def weight_number(parameters, key, label, low, high):
    value = parameters.get(key)
    if not finite_number(value) or value < low or value > high:
        fail(f"模型权重 {label} 缺失或超出范围。")
    return float(value)


def variogram_shape(model, h, a):
    """结构部分，0 到 1。三种模型都用实用变程：h 等于 a 时达到基台的约 95%（球状正好 100%）。"""
    import numpy

    t = h / a
    if model == "spherical":
        return numpy.where(t < 1.0, 1.5 * t - 0.5 * t ** 3, 1.0)
    if model == "exponential":
        return 1.0 - numpy.exp(-3.0 * t)
    return 1.0 - numpy.exp(-3.0 * t * t)


def empirical_variogram(xy, z, rng, bins=15, cap=1500):
    import numpy

    if len(z) > cap:
        picked = rng.choice(len(z), cap, replace=False)
        xy = xy[picked]
        z = z[picked]
    upper = numpy.triu_indices(len(z), 1)
    distance = numpy.sqrt(((xy[:, None, :] - xy[None, :, :]) ** 2).sum(-1))[upper]
    semivariance = (0.5 * (z[:, None] - z[None, :]) ** 2)[upper]
    edges = numpy.linspace(0.0, 0.5, bins + 1)
    lags, gammas, counts = [], [], []
    for low, high in zip(edges[:-1], edges[1:]):
        inside = (distance > low) & (distance <= high)
        count = int(inside.sum())
        if count < 3:
            continue
        lags.append(float(distance[inside].mean()))
        gammas.append(float(semivariance[inside].mean()))
        counts.append(count)
    return numpy.array(lags), numpy.array(gammas), numpy.array(counts, dtype="float64")


def fit_variogram(lags, gammas, counts, model, prior_nugget, prior_range, prior_weight, point_count):
    """网格搜索变程和块金比例，基台按加权最小二乘闭式求出。目标 = 归一化残差 + 先验权重 ÷ 点数 × 偏离先验的平方。"""
    import numpy

    ranges = numpy.unique(numpy.append(numpy.geomspace(0.01, 1.5, 60), prior_range))
    nuggets = numpy.unique(numpy.append(numpy.linspace(0.0, 0.9, 19), prior_nugget))
    if model == "gaussian":
        # 高斯模型块金为 0 时克里金方程组接近奇异，留一误差和方差都会失真。
        nuggets = numpy.unique(numpy.maximum(nuggets, 0.002))
    weights = counts / counts.sum()
    scale = float((weights * gammas ** 2).sum())
    shape = variogram_shape(model, lags[None, :], ranges[:, None])
    curve = nuggets[None, :, None] + (1.0 - nuggets[None, :, None]) * shape[:, None, :]
    sill = (weights * gammas * curve).sum(-1) / (weights * curve ** 2).sum(-1)
    misfit = (weights * (gammas - sill[..., None] * curve) ** 2).sum(-1) / scale
    penalty = numpy.log(ranges / prior_range)[:, None] ** 2 + ((nuggets - prior_nugget) / 0.25)[None, :] ** 2
    lam = prior_weight / point_count
    objective = numpy.where(sill > 0, misfit + lam * penalty, numpy.inf)
    objective = numpy.where(numpy.isfinite(objective), objective, numpy.inf)
    best = numpy.unravel_index(int(numpy.argmin(objective)), objective.shape)
    prior_share = float(lam * penalty[best] / objective[best]) if objective[best] > 0 else 0.0
    return float(ranges[best[0]]), float(nuggets[best[1]]), float(sill[best]), float(misfit[best]), prior_share


def krige(xy, z, targets, neighbors, model, sill, nugget, a, self_index=None):
    """局部普通克里金（协方差形式），按块批量解方程组。self_index 不为空时做留一，排除目标自己。"""
    import numpy

    count = len(z)
    k = min(neighbors, count - (1 if self_index is not None else 0))
    structured = sill * (1.0 - nugget)

    def covariance(h):
        return numpy.where(h > 0, structured * (1.0 - variogram_shape(model, h, a)), sill)

    predictions = numpy.empty(len(targets))
    variances = numpy.empty(len(targets))
    chunk = max(1, min(4096, 4_000_000 // count))
    for start in range(0, len(targets), chunk):
        block = targets[start:start + chunk]
        distance = numpy.sqrt(((block[:, None, :] - xy[None, :, :]) ** 2).sum(-1))
        if self_index is not None:
            distance[numpy.arange(len(block)), self_index[start:start + chunk]] = numpy.inf
        near = numpy.argpartition(distance, k - 1, axis=1)[:, :k]
        points = xy[near]
        between = numpy.sqrt(((points[:, :, None, :] - points[:, None, :, :]) ** 2).sum(-1))
        system = numpy.ones((len(block), k + 1, k + 1))
        system[:, :k, :k] = covariance(between) + numpy.eye(k) * sill * 1e-9
        system[:, k, k] = 0.0
        right = numpy.ones((len(block), k + 1))
        target_cov = covariance(numpy.take_along_axis(distance, near, axis=1))
        right[:, :k] = target_cov
        try:
            solution = numpy.linalg.solve(system, right[..., None])[..., 0]
        except numpy.linalg.LinAlgError:
            solution = (numpy.linalg.pinv(system) @ right[..., None])[..., 0]
        weights = solution[:, :k]
        predictions[start:start + chunk] = (weights * z[near]).sum(1)
        variances[start:start + chunk] = numpy.maximum(sill - (weights * target_cov).sum(1) - solution[:, k], 0.0)
    return predictions, variances


def raster_kriging(request):
    import math
    from osgeo import gdal
    import numpy

    gdal.UseExceptions()
    parameters = request["parameters"]
    field = str(parameters.get("field") or "").strip()
    if field == "":
        fail("克里金需要数值字段。")
    model = str(parameters.get("variogram") or "")
    if model not in ("spherical", "exponential", "gaussian"):
        fail("模型权重的半变异函数不支持。")
    prior_nugget = weight_number(parameters, "nuggetRatio", "nuggetRatio", 0.0, 0.95)
    prior_range = weight_number(parameters, "rangeRatio", "rangeRatio", 0.005, 3.0)
    prior_weight = weight_number(parameters, "priorWeight", "priorWeight", 0.0, 10000.0)
    neighbors = int(weight_number(parameters, "neighbors", "neighbors", 4, 64))
    cell = parameters.get("cellSize")
    if cell is not None and (not finite_number(cell) or cell <= 0):
        fail("格网边长必须大于 0。")
    projection = layer_projection(request)
    unit = planar_unit(projection, "克里金")
    rows = {}
    for feature in read_features(request["inputResources"][0]):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            continue
        pair = geometry.get("coordinates") or []
        value = (feature.get("properties") or {}).get(field)
        if len(pair) < 2 or not finite_number(pair[0]) or not finite_number(pair[1]) or not finite_number(value):
            continue
        rows.setdefault((float(pair[0]), float(pair[1])), []).append(float(value))
    if len(rows) < 10:
        fail("克里金至少需要 10 个不同位置的有效点。")
    if len(rows) > 5000:
        fail("克里金最多支持 5000 个点。请先抽样或聚合。")
    raw_xy = numpy.array(list(rows.keys()), dtype="float64")
    raw_z = numpy.array([sum(values) / len(values) for values in rows.values()], dtype="float64")
    merged = sum(len(values) for values in rows.values()) - len(rows)
    mean = float(raw_z.mean())
    spread = float(raw_z.std())
    if spread == 0:
        fail("字段值全部相同，不能做克里金。")
    low = raw_xy.min(0)
    high = raw_xy.max(0)
    diagonal = float(math.hypot(*(high - low)))
    if diagonal == 0:
        fail("点都在同一位置。")
    center = (low + high) / 2.0
    xy = (raw_xy - center) / diagonal
    z = (raw_z - mean) / spread
    rng = numpy.random.default_rng(20261017)
    lags, gammas, counts = empirical_variogram(xy, z, rng)
    if len(lags) < 3:
        fail("点的间距分布太窄，算不出经验半变异函数。")
    if not (gammas > 0).any():
        fail("点在统计距离内没有变化，经验半变异函数全为 0，不能做克里金。")
    rng_ratio, nugget, sill, misfit, prior_share = fit_variogram(lags, gammas, counts, model, prior_nugget, prior_range, prior_weight, len(z))
    loo_pred, loo_var = krige(xy, z, xy, neighbors, model, sill, nugget, rng_ratio, self_index=numpy.arange(len(z)))
    errors = (loo_pred - z) * spread
    rmse = float(numpy.sqrt((errors ** 2).mean()))
    mae = float(numpy.abs(errors).mean())
    positive = loo_var > 0
    msdr = float(((errors[positive] ** 2) / (loo_var[positive] * spread ** 2)).mean()) if positive.any() else float("nan")
    pad = (high - low) * 0.05
    pad = numpy.where(pad > 0, pad, diagonal * 0.05)
    x0, y0 = low - pad
    x1, y1 = high + pad
    if cell is None:
        cell = max(x1 - x0, y1 - y0) / 200.0
    width = max(1, int(math.ceil((x1 - x0) / float(cell) - 1e-9)))
    height = max(1, int(math.ceil((y1 - y0) / float(cell) - 1e-9)))
    if width * height > 250000:
        fail("克里金格网超过 25 万像元。请加大边长。")
    columns = x0 + (numpy.arange(width) + 0.5) * float(cell)
    rows_y = y1 - (numpy.arange(height) + 0.5) * float(cell)
    grid_x, grid_y = numpy.meshgrid(columns, rows_y)
    targets = (numpy.column_stack([grid_x.ravel(), grid_y.ravel()]) - center) / diagonal
    pred, var = krige(xy, z, targets, neighbors, model, sill, nugget, rng_ratio)
    driver = gdal.GetDriverByName("GTiff")
    outputs = []
    for suffix, array in (("-kriging.tif", pred * spread + mean), ("-variance.tif", var * spread ** 2)):
        destination = output_path(request, suffix)
        dataset = driver.Create(destination, width, height, 1, gdal.GDT_Float32)
        dataset.SetGeoTransform([float(x0), float(cell), 0, float(y1), 0, -float(cell)])
        if projection:
            dataset.SetProjection(projection)
        band = dataset.GetRasterBand(1)
        band.SetNoDataValue(-9999)
        band.WriteArray(array.reshape(height, width).astype("float32"))
        dataset.FlushCache()
        dataset = None
        outputs.append(relative(destination))
    units = unit_label(unit)
    real_range = rng_ratio * diagonal
    real_sill = sill * spread ** 2
    real_nugget = nugget * real_sill
    prior_text = f"先验变程 {prior_range * diagonal:.4g} {units}、块金比例 {prior_nugget:.3g}，按 {len(z)} 个点调整后先验项占拟合目标的 {prior_share:.0%}。"
    merged_text = f"同一位置的 {merged} 个重复点取了平均。" if merged > 0 else ""
    msdr_text = f"，标准化误差平方均值 {msdr:.3g}（接近 1 说明方差与误差相符，远小于 1 说明方差偏大，远大于 1 说明偏小）" if msdr == msdr else ""
    ok(
        facts={
            "rmse": rmse,
            "mae": mae,
            "heldOut": int(len(z)),
            "msdr": msdr if msdr == msdr else None,
            "variogram": model,
            "range": real_range,
            "sill": real_sill,
            "nugget": real_nugget,
            "width": width,
            "height": height,
        },
        message=(
            f"普通克里金完成，{width}×{height}，每格用最近 {min(neighbors, len(z))} 个点。"
            f"{model} 半变异函数：块金 {real_nugget:.4g}，基台 {real_sill:.4g}，变程 {real_range:.4g} {units}，拟合残差 {misfit:.3g}。{prior_text}"
            f"留一交叉验证 {len(z)} 个点：均方根误差 {rmse:.4g}，平均绝对误差 {mae:.4g}{msdr_text}。{merged_text}"
            "第二个栅格是克里金方差。"
        ),
        outputs=outputs,
    )


def priority_flood(dem, valid):
    """Priority-Flood 加 ε（Barnes 2014）。洼地抬到出口高度再加一个最小浮点增量，保证每个内部像元都有更低的邻居。"""
    import heapq
    import math
    import numpy

    height, width = dem.shape
    stride = width + 2
    padded_valid = numpy.zeros((height + 2, width + 2), dtype=bool)
    padded_valid[1:-1, 1:-1] = valid
    surface = numpy.full((height + 2, width + 2), numpy.nan)
    surface[1:-1, 1:-1] = numpy.where(valid, dem, numpy.nan)
    blocked = ~padded_valid
    edge = numpy.zeros_like(padded_valid)
    for d_row in (-1, 0, 1):
        for d_column in (-1, 0, 1):
            if d_row == 0 and d_column == 0:
                continue
            edge |= numpy.roll(numpy.roll(blocked, d_row, axis=0), d_column, axis=1)
    seeds = padded_valid & edge
    values = surface.ravel().tolist()
    closed = blocked.ravel().tolist()
    queue = []
    for index in numpy.flatnonzero(seeds).tolist():
        closed[index] = True
        queue.append((values[index], index))
    heapq.heapify(queue)
    offsets = (-stride - 1, -stride, -stride + 1, -1, 1, stride - 1, stride, stride + 1)
    raise_to = math.nextafter
    infinity = math.inf
    pop = heapq.heappop
    push = heapq.heappush
    while queue:
        level, index = pop(queue)
        for offset in offsets:
            neighbor = index + offset
            if closed[neighbor]:
                continue
            closed[neighbor] = True
            value = values[neighbor]
            if value <= level:
                value = raise_to(level, infinity)
                values[neighbor] = value
            push(queue, (value, neighbor))
    filled = numpy.array(values).reshape(height + 2, width + 2)
    return filled, seeds


def d8_receivers(filled, valid_padded, step_x, step_y):
    """每个像元流向下降最陡的邻居；没有更低邻居的边缘像元是出口（-1）。下标在补边网格上，补边一圈是 NaN，所以平移回绕不影响有效像元。"""
    import math
    import numpy

    rows, columns = filled.shape
    diagonal = math.hypot(step_x, step_y)
    best = numpy.zeros(filled.shape)
    receiver = numpy.full(filled.shape, -1, dtype="int64")
    index = numpy.arange(rows * columns).reshape(rows, columns)
    for d_row, d_column, length in ((-1, -1, diagonal), (-1, 0, step_y), (-1, 1, diagonal), (0, -1, step_x), (0, 1, step_x), (1, -1, diagonal), (1, 0, step_y), (1, 1, diagonal)):
        neighbor = numpy.roll(filled, (-d_row, -d_column), axis=(0, 1))
        with numpy.errstate(invalid="ignore"):
            drop = (filled - neighbor) / length
        drop = numpy.where(numpy.isnan(drop), -numpy.inf, drop)
        better = drop > best
        best = numpy.where(better, drop, best)
        receiver = numpy.where(better, index + d_row * columns + d_column, receiver)
    receiver[~valid_padded] = -1
    return receiver


def flow_routing(dem, valid, step_x, step_y):
    """填洼、D8 流向和汇流累积量（像元个数，含自身）。receiver 和 downhill 的下标在补边一圈的网格上。"""
    import numpy

    filled, _ = priority_flood(dem, valid)
    valid_padded = numpy.zeros(filled.shape, dtype=bool)
    valid_padded[1:-1, 1:-1] = valid
    receiver = d8_receivers(filled, valid_padded, step_x, step_y).ravel().tolist()
    cells = numpy.flatnonzero(valid_padded.ravel())
    downhill = cells[numpy.argsort(-filled.ravel()[cells], kind="stable")].tolist()
    totals = valid_padded.ravel().astype("float64").tolist()
    for index in downhill:
        target = receiver[index]
        if target >= 0:
            totals[target] += totals[index]
    accumulation = numpy.array(totals).reshape(filled.shape)[1:-1, 1:-1]
    return {"receiver": receiver, "downhill": downhill, "accumulation": accumulation, "stride": dem.shape[1] + 2, "shape": filled.shape}


def snap_outlet(accumulation, valid, row, column, step_x, step_y, snap_distance):
    """捕捉半径内汇流累积量最大的有效像元，并列时取最近的。没有可用像元返回 None。"""
    import numpy

    height, width = accumulation.shape
    radius_x = int(snap_distance // step_x)
    radius_y = int(snap_distance // step_y)
    window_rows, window_columns = numpy.mgrid[max(0, row - radius_y):min(height, row + radius_y + 1), max(0, column - radius_x):min(width, column + radius_x + 1)]
    offsets = numpy.hypot((window_columns - column) * step_x, (window_rows - row) * step_y)
    usable = valid[window_rows, window_columns] & (offsets <= snap_distance + 1e-9)
    if not usable.any():
        return None
    candidate_offset = offsets[usable]
    pick = numpy.lexsort((candidate_offset, -accumulation[window_rows, window_columns][usable]))[0]
    return int(window_rows[usable][pick]), int(window_columns[usable][pick]), float(candidate_offset[pick])


def label_basins(routing, outlets):
    """outlets 是 {补边下标: 编号}。每个像元归到顺流遇到的第一个出水口；0 表示不流向任何出水口。"""
    import numpy

    rows, columns = routing["shape"]
    receiver = routing["receiver"]
    labels = [0] * (rows * columns)
    for index, number in outlets.items():
        labels[index] = number
    for index in reversed(routing["downhill"]):
        if labels[index]:
            continue
        target = receiver[index]
        if target >= 0:
            labels[index] = labels[target]
    return numpy.array(labels).reshape(rows, columns)[1:-1, 1:-1]


def raster_watershed(request):
    from osgeo import gdal, ogr
    import numpy

    gdal.UseExceptions()
    sources = request["inputResources"]
    if len(sources) < 2:
        fail("汇水分析需要 DEM 和出水口点图层。")
    parameters = request["parameters"]
    stream_area = weight_number(parameters, "streamArea", "streamArea", 1e-9, 1e12)
    snap_distance = weight_number(parameters, "snapDistance", "snapDistance", 0.0, 100000.0)
    dataset = gdal.Open(resolve_resource(sources[0]))
    if dataset is None:
        fail("无法打开 DEM。")
    width, height = dataset.RasterXSize, dataset.RasterYSize
    if width * height > 1000000:
        fail("DEM 超过 100 万像元。请先重采样。")
    check_layer_crs(dataset, request)
    transform = dataset.GetGeoTransform()
    if transform[2] != 0 or transform[4] != 0:
        fail("DEM 不能有旋转。")
    unit = planar_unit(dataset.GetProjection(), "汇水分析")
    if unit is None:
        fail("DEM 没有坐标系，汇水面积和捕捉半径无法换算成像元。请用带投影坐标系的 GeoTIFF。")
    band = dataset.GetRasterBand(1)
    dem = band.ReadAsArray().astype("float64")
    valid = valid_mask(dem, band.GetNoDataValue())
    if not valid.any():
        fail("DEM 没有有效像元。")
    step_x = abs(transform[1]) * unit
    step_y = abs(transform[5]) * unit
    cell_area = step_x * step_y
    routing = flow_routing(dem, valid, step_x, step_y)
    accumulation = routing["accumulation"]
    threshold = stream_area / cell_area
    stride = routing["stride"]
    # 紧邻 DEM 内部 NoData 的像元和外框一样是出口，水流到这里为止。
    terminal = numpy.array(routing["receiver"]).reshape(routing["shape"])[1:-1, 1:-1] < 0
    frame = numpy.zeros_like(valid)
    frame[0, :] = frame[-1, :] = frame[:, 0] = frame[:, -1] = True
    inner_outlets = valid & terminal & ~frame
    inner_note = (
        f"{int(inner_outlets.sum())} 个像元紧邻 DEM 内部的 NoData，按出口处理，共 {int(accumulation[inner_outlets].sum())} 个像元的水流到这些出口。"
        if inner_outlets.any() else ""
    )
    outlets = []
    snapped = {}
    points = [feature for feature in read_features(sources[1]) if (feature.get("geometry") or {}).get("type") == "Point"]
    if not points:
        fail("汇水分析需要至少一个出水口点。")
    if len(points) > 50:
        fail("出水口最多 50 个。")
    notes = []
    for number, feature in enumerate(points, start=1):
        pair = feature["geometry"].get("coordinates") or []
        if len(pair) < 2 or not finite_number(pair[0]) or not finite_number(pair[1]):
            fail(f"第 {number} 个出水口坐标无效。")
        row, column = cell_of(transform, width, height, float(pair[0]), float(pair[1]), f"第 {number} 个出水口")
        picked = snap_outlet(accumulation, valid, row, column, step_x, step_y, snap_distance)
        if picked is None:
            fail(f"第 {number} 个出水口附近没有有效像元。")
        r, c, offset = picked
        padded_index = (r + 1) * stride + (c + 1)
        if padded_index in snapped:
            notes.append(f"第 {number} 个出水口和第 {snapped[padded_index]} 个捕捉到同一像元，已合并。")
            continue
        snapped[padded_index] = number
        outlets.append((number, padded_index, offset, float(accumulation[r, c])))
    labels = label_basins(routing, snapped)
    projection = dataset.GetProjection()
    acc_path = output_path(request, "-accumulation.tif")
    write_raster(dataset, numpy.where(valid, accumulation, -9999.0).astype("float32"), acc_path, gdal.GDT_Float32, -9999.0)
    streams = numpy.where(valid, (accumulation >= threshold).astype("float64"), 255.0)
    stream_path = output_path(request, "-streams.tif")
    write_raster(dataset, streams.astype("uint8"), stream_path, gdal.GDT_Byte, 255)
    memory = gdal.GetDriverByName("MEM").Create("", width, height, 1, gdal.GDT_Int32)
    memory.SetGeoTransform(transform)
    memory.SetProjection(projection)
    label_band = memory.GetRasterBand(1)
    label_band.WriteArray(labels.astype("int32"))
    basin_path = output_path(request, "-basins.geojson")
    datasource = ogr.GetDriverByName("GeoJSON").CreateDataSource(basin_path)
    layer = datasource.CreateLayer("basin", srs=dataset.GetSpatialRef(), geom_type=ogr.wkbPolygon)
    layer.CreateField(ogr.FieldDefn("basin", ogr.OFTInteger))
    gdal.Polygonize(label_band, label_band, layer, 0, ["8CONNECTED=8"], callback=None)
    datasource = None
    written = ogr.Open(basin_path)
    polygons = written.GetLayer(0).GetFeatureCount()
    written = None
    memory = None
    dataset = None
    rows = []
    for number, padded_index, offset, upstream in outlets:
        own = int(numpy.count_nonzero(labels == number))
        rows.append(f"出水口 {number}：捕捉 {offset:.1f} 米，汇水面积 {own * cell_area / 1e6:.4g} 平方千米（{own} 像元），上游总面积 {upstream * cell_area / 1e6:.4g} 平方千米")
    stream_cells = int(numpy.count_nonzero(valid & (accumulation >= threshold)))
    ok(
        facts={"featureCount": len(outlets), "streamArea": stream_area, "snapDistance": snap_distance},
        message=(
            f"{len(outlets)} 个流域，{polygons} 个面。D8 流向，洼地用 Priority-Flood 填平。"
            f"河道阈值 {stream_area / 1e6:.4g} 平方千米（{threshold:.1f} 像元），河道像元 {stream_cells} 个；捕捉半径 {snap_distance:.4g} 米。"
            + "；".join(rows[:30]) + "。"
            + (f"其余 {len(rows) - 30} 个出水口没有列出。" if len(rows) > 30 else "")
            + "".join(notes) + inner_note
        ),
        outputs=[relative(basin_path), relative(acc_path), relative(stream_path)],
    )


def first_line(resource):
    for feature in read_features(resource):
        geometry = feature.get("geometry") or {}
        kind = geometry.get("type")
        parts = [geometry.get("coordinates") or []] if kind == "LineString" else (geometry.get("coordinates") or []) if kind == "MultiLineString" else []
        for part in parts:
            line = [(float(pair[0]), float(pair[1])) for pair in part if len(pair) >= 2 and finite_number(pair[0]) and finite_number(pair[1])]
            if len(line) >= 2:
                return line
    fail("剖面需要一条至少两个点的线。")


def sample_raster(array, valid, transform, x, y):
    """双线性插值。四个邻格有缺值时退回所在像元；所在像元也无效时为 None。"""
    import math

    height, width = array.shape
    u = (x - transform[0]) / transform[1]
    v = (y - transform[3]) / transform[5]
    if u < 0 or v < 0 or u >= width or v >= height:
        return None
    column = int(u)
    row = int(v)
    left = int(math.floor(u - 0.5))
    top = int(math.floor(v - 0.5))
    fx = u - 0.5 - left
    fy = v - 0.5 - top
    corners = []
    for r, c, weight in ((top, left, (1 - fx) * (1 - fy)), (top, left + 1, fx * (1 - fy)), (top + 1, left, (1 - fx) * fy), (top + 1, left + 1, fx * fy)):
        rr = min(max(r, 0), height - 1)
        cc = min(max(c, 0), width - 1)
        if not valid[rr, cc]:
            corners = None
            break
        corners.append(float(array[rr, cc]) * weight)
    if corners is not None:
        return sum(corners)
    return float(array[row, column]) if valid[row, column] else None


def raster_profile(request):
    import math
    from osgeo import gdal

    gdal.UseExceptions()
    sources = request["inputResources"]
    if len(sources) < 2:
        fail("剖面需要 DEM 和线图层。")
    dataset = gdal.Open(resolve_resource(sources[0]))
    if dataset is None:
        fail("无法打开 DEM。")
    check_layer_crs(dataset, request)
    transform = dataset.GetGeoTransform()
    if transform[2] != 0 or transform[4] != 0:
        fail("DEM 不能有旋转。")
    unit = planar_unit(dataset.GetProjection(), "剖面")
    band = dataset.GetRasterBand(1)
    array = band.ReadAsArray().astype("float64")
    valid = valid_mask(array, band.GetNoDataValue())
    dataset = None
    line = first_line(sources[1])
    segments = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(line[:-1], line[1:])]
    total = sum(segments)
    if total == 0:
        fail("线的长度为 0。")
    step = min(abs(transform[1]), abs(transform[5]))
    count = int(math.ceil(total / step)) + 1
    if count > 5001:
        count = 5001
    scale = unit if unit is not None else 1.0
    features = []
    samples = []
    segment = 0
    walked = 0.0
    for i in range(count):
        along = total * i / (count - 1)
        while segment < len(segments) - 1 and walked + segments[segment] < along:
            walked += segments[segment]
            segment += 1
        a, b = line[segment], line[segment + 1]
        t = 0.0 if segments[segment] == 0 else min(1.0, max(0.0, (along - walked) / segments[segment]))
        x = a[0] + (b[0] - a[0]) * t
        y = a[1] + (b[1] - a[1]) * t
        elevation = sample_raster(array, valid, transform, x, y)
        distance = along * scale
        samples.append((distance, elevation))
        features.append({"type": "Feature", "properties": {"distance": round(distance, 6), "elevation": elevation}, "geometry": {"type": "Point", "coordinates": [x, y]}})
    known = [(d, e) for d, e in samples if e is not None]
    if not known:
        fail("线没有经过 DEM 的有效像元。")
    ascent = descent = 0.0
    steepest = 0.0
    # 只算相邻两个采样点都有值的段；跨过 NoData 的高差不知道走法，不计入。
    for (d0, e0), (d1, e1) in zip(samples[:-1], samples[1:]):
        if e0 is None or e1 is None:
            continue
        rise = e1 - e0
        if rise > 0:
            ascent += rise
        else:
            descent -= rise
        if d1 > d0:
            steepest = max(steepest, abs(rise) / (d1 - d0))
    destination = output_path(request, "-profile.geojson")
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": features}, handle)
    units = unit_label(unit if unit is None else 1.0)
    low = min(e for _, e in known)
    high = max(e for _, e in known)
    missing = len(samples) - len(known)
    ok(
        facts={"featureCount": len(features), "length": total * scale, "minimum": low, "maximum": high, "ascent": ascent, "descent": descent},
        message=(
            f"线长 {total * scale:.6g} {units}，{len(features)} 个采样点，间隔约 {total * scale / (count - 1):.4g} {units}，双线性插值。"
            f"高程最低 {low:.6g}，最高 {high:.6g}，累计爬升 {ascent:.6g}，累计下降 {descent:.6g}，相邻采样点最大坡度 {steepest * 100:.4g}%（高程和水平距离同单位时成立）。"
            + (f"{missing} 个采样点不在有效像元上，elevation 为空，这些地方不计爬升和下降。" if missing else "")
        ),
        outputs=[relative(destination)],
    )


def raster_cut_fill(request):
    from osgeo import gdal, osr
    import numpy

    gdal.UseExceptions()
    sources = request["inputResources"]
    if len(sources) < 2:
        fail("填挖方需要现状和设计两个高程栅格。")
    before = gdal.Open(resolve_resource(sources[0]))
    after = gdal.Open(resolve_resource(sources[1]))
    if before is None or after is None:
        fail("无法打开高程栅格。")
    first_transform = before.GetGeoTransform()
    if before.RasterXSize != after.RasterXSize or before.RasterYSize != after.RasterYSize or any(abs(x - y) > 1e-9 * max(1.0, abs(x)) for x, y in zip(first_transform, after.GetGeoTransform())):
        fail("两个高程栅格不在同一网格。请先重采样对齐。")
    first_projection = before.GetProjection()
    second_projection = after.GetProjection()
    if bool(first_projection) != bool(second_projection):
        fail("一个高程栅格有坐标系，另一个没有。请先给两个栅格设同一坐标系。")
    if first_projection and second_projection:
        first_srs = osr.SpatialReference()
        first_srs.ImportFromWkt(first_projection)
        second_srs = osr.SpatialReference()
        second_srs.ImportFromWkt(second_projection)
        if not first_srs.IsSame(second_srs):
            fail("两个高程栅格的坐标系不同。")
    unit = planar_unit(first_projection or second_projection, "填挖方")
    a_band = before.GetRasterBand(1)
    b_band = after.GetRasterBand(1)
    a = a_band.ReadAsArray().astype("float64")
    b = b_band.ReadAsArray().astype("float64")
    valid = valid_mask(a, a_band.GetNoDataValue()) & valid_mask(b, b_band.GetNoDataValue())
    if not valid.any():
        fail("两个栅格没有共同的有效像元。")
    difference = numpy.where(valid, b - a, 0.0)
    scale = unit if unit is not None else 1.0
    cell_area = abs(first_transform[1] * first_transform[5] - first_transform[2] * first_transform[4]) * scale * scale
    fill_volume = float(difference[difference > 0].sum() * cell_area)
    cut_volume = float(-difference[difference < 0].sum() * cell_area)
    fill_area = float(numpy.count_nonzero(difference > 0) * cell_area)
    cut_area = float(numpy.count_nonzero(difference < 0) * cell_area)
    destination = output_path(request, "-cutfill.tif")
    write_raster(before, numpy.where(valid, difference, -9999.0).astype("float32"), destination, gdal.GDT_Float32, -9999.0)
    before = None
    after = None
    volume_unit = "立方米（高程按米）" if unit is not None else "立方坐标单位（高程与坐标同单位时）"
    area_unit = "平方米" if unit is not None else "平方坐标单位"
    skipped = int(valid.size - numpy.count_nonzero(valid))
    ok(
        facts={"cut": cut_volume, "fill": fill_volume, "net": fill_volume - cut_volume, "featureCount": int(numpy.count_nonzero(valid))},
        message=(
            f"填挖方完成。差值 = 第二个栅格减第一个栅格，正为填、负为挖。"
            f"填方 {fill_volume:.6g} {volume_unit}，面积 {fill_area:.6g} {area_unit}；挖方 {cut_volume:.6g} {volume_unit}，面积 {cut_area:.6g} {area_unit}；"
            f"净方量 {fill_volume - cut_volume:.6g}（正为需要借土）。"
            + (f"{skipped} 个像元在任一栅格里是 NoData，没有计入。" if skipped else "")
        ),
        outputs=[relative(destination)],
    )


def raster_water_level(request):
    from osgeo import gdal
    import numpy

    gdal.UseExceptions()
    sources = request["inputResources"]
    if len(sources) < 1:
        fail("水位推演需要一个高程栅格。")
    water = request["parameters"].get("waterLevel")
    if not finite_number(water):
        fail("水位没写。请给出水面高程，程序不会填一个数。")
    source = gdal.Open(resolve_resource(sources[0]))
    if source is None:
        fail("无法打开高程栅格。")
    projection = source.GetProjection()
    unit = planar_unit(projection, "水位推演")
    band = source.GetRasterBand(1)
    elevation = band.ReadAsArray().astype("float64")
    valid = valid_mask(elevation, band.GetNoDataValue())
    if not valid.any():
        fail("高程栅格没有有效像元。")
    depth = numpy.where(valid, numpy.maximum(float(water) - elevation, 0.0), -9999.0)
    flooded = valid & (elevation < float(water))
    scale = unit if unit is not None else 1.0
    transform = source.GetGeoTransform()
    cell_area = abs(transform[1] * transform[5] - transform[2] * transform[4]) * scale * scale
    flooded_area = float(numpy.count_nonzero(flooded) * cell_area)
    max_depth = float(depth[flooded].max()) if flooded.any() else 0.0
    destination = output_path(request, "-depth.tif")
    write_raster(source, depth.astype("float32"), destination, gdal.GDT_Float32, -9999.0)
    source = None
    meters = unit is not None and abs(unit - 1.0) < 1e-12
    depth_unit = "米" if meters else ("高程单位" if unit is None else "投影长度单位")
    area_unit = "平方米" if meters else "平方坐标单位"
    ok(
        facts={"maximum": max_depth, "featureCount": int(numpy.count_nonzero(flooded))},
        message=f"水面高程 {float(water):.6g} 减地面高程。最高水深 {max_depth:.6g} {depth_unit}，淹没面积 {flooded_area:.6g} {area_unit}。没有流速，也没有时间。",
        outputs=[relative(destination)],
    )


def raster_terrain(request):
    """三维页用的降采样网格。只写本地 JSON，由 Node 读给页面，不进模型。"""
    from osgeo import gdal, osr
    import numpy

    gdal.UseExceptions()
    max_size = request["parameters"].get("maxSize")
    if not finite_number(max_size) or not (8 <= max_size <= 512):
        fail("三维地形的网格上限要在 8 到 512 之间。")
    source = gdal.Open(resolve_resource(request["inputResources"][0]))
    if source is None:
        fail("无法打开栅格。")
    projection = source.GetProjection()
    unit = planar_unit(projection, "三维地形")
    transform = source.GetGeoTransform()
    if abs(transform[2]) > 1e-12 or abs(transform[4]) > 1e-12:
        fail("三维地形不支持旋转的栅格。")
    width, height = source.RasterXSize, source.RasterYSize
    scale = max(1.0, max(width, height) / float(max_size))
    out_width = max(2, int(round(width / scale)))
    out_height = max(2, int(round(height / scale)))
    band = source.GetRasterBand(1)
    nodata = band.GetNoDataValue()
    if out_width != width or out_height != height:
        sampled = gdal.Translate("", source, format="MEM", width=out_width, height=out_height, resampleAlg="average")
        array = sampled.GetRasterBand(1).ReadAsArray().astype("float64")
        sampled = None
    else:
        array = band.ReadAsArray().astype("float64")
    valid = valid_mask(array, nodata)
    minx = transform[0]
    maxx = transform[0] + width * transform[1]
    maxy = transform[3]
    miny = transform[3] + height * transform[5]
    epsg = None
    if projection:
        srs = osr.SpatialReference()
        srs.ImportFromWkt(projection)
        code = srs.GetAuthorityCode(None)
        epsg = int(code) if code and code.isdigit() else None
    values = [round(float(v), 4) if ok_cell else None for v, ok_cell in zip(array.reshape(-1).tolist(), valid.reshape(-1).tolist())]
    destination = output_path(request, "-terrain.json")
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump({
            "width": out_width,
            "height": out_height,
            "extent": [min(minx, maxx), min(miny, maxy), max(minx, maxx), max(miny, maxy)],
            "unitToMeter": unit if unit is not None else 1.0,
            "epsg": epsg,
            "minimum": float(array[valid].min()) if valid.any() else None,
            "maximum": float(array[valid].max()) if valid.any() else None,
            "values": values,
        }, handle)
    source = None
    ok(facts={}, message="三维地形已采样。", outputs=[relative(destination)])


CAPABILITIES.update({
    "raster.terrain": raster_terrain,
    "raster.info": raster_info,
    "raster.calc": raster_calc,
    "raster.demDerivative": dem_derivative,
    "raster.contour": contour,
    "raster.cast": raster_cast,
    "raster.nodata": raster_nodata,
    "raster.smooth": raster_smooth,
    "raster.grid": raster_grid,
    "raster.viewshed": raster_viewshed,
    "raster.clip": raster_clip,
    "raster.polygonize": raster_polygonize,
    "raster.rasterize": raster_rasterize,
    "raster.zonal": raster_zonal,
    "raster.resample": raster_resample,
    "raster.index": raster_index,
    "raster.focal": raster_focal,
    "raster.costCorridor": raster_cost_corridor,
    "raster.classify": raster_classify,
    "raster.kriging": raster_kriging,
    "raster.watershed": raster_watershed,
    "raster.profile": raster_profile,
    "raster.cutFill": raster_cut_fill,
    "raster.waterLevel": raster_water_level,
    "vector.offset": vector_offset,
})


def main():
    if "--check" in sys.argv:
        try:
            from osgeo import gdal, ogr, osr

            print(json.dumps({"ok": True, "gdalVersion": gdal.VersionInfo("--version"), "ogr": ogr.GetDriverCount() > 0, "osr": bool(osr.SpatialReference())}, ensure_ascii=False))
            return
        except Exception as error:
            print(json.dumps({"ok": False, "message": f"{type(error).__name__}: {error}"}, ensure_ascii=False))
            sys.exit(1)
    try:
        request = json.load(sys.stdin)
    except Exception:
        fail("请求不是合法 JSON。")
        return
    capability = request.get("capability", "")
    handler = CAPABILITIES.get(capability)
    if handler is None:
        fail(f"未知外部能力：{capability}")
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
