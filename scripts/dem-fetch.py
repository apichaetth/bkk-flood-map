# DeltaDTM v1.1 (Pronk et al. 2024, CC BY 4.0): ดึงไทล์ที่ครอบคลุม กทม. จาก Asia.zip แบบ HTTP range แล้วตัดเฉพาะ กทม.
import os, json, numpy as np, rasterio
from rasterio.windows import from_bounds
from remotezip import RemoteZip
URL = 'https://data.4tu.nl/file/1da2e70f-6c4d-4b03-86bd-b53e789cc629/672eba4c-1334-44c6-8119-8879ded25912'
BBOX = (100.32, 13.48, 100.95, 13.97)  # lon_min, lat_min, lon_max, lat_max
os.makedirs('dem-out', exist_ok=True)
with RemoteZip(URL) as z:
    names = z.namelist()
    print('entries', len(names), names[:5])
    hits = [n for n in names if ('N13' in n and 'E100' in n)]
    print('bangkok tile candidates', hits)
    for n in hits:
        z.extract(n, 'tiles')
tifs = [os.path.join(dp, f) for dp, _, fs in os.walk('tiles') for f in fs if f.endswith('.tif')]
print('tifs', tifs)
src = rasterio.open(tifs[0])
print('crs', src.crs, 'res', src.res, 'nodata', src.nodata, 'bounds', src.bounds, 'dtype', src.dtypes)
win = from_bounds(*BBOX, transform=src.transform)
a = src.read(1, window=win).astype('float32')
tr = src.window_transform(win)
nod = src.nodata
if nod is not None: a[a == nod] = np.nan
a[a < -50] = np.nan
v = a[np.isfinite(a)]
stats = {'shape': a.shape, 'res_deg': src.res, 'transform': list(tr)[:6], 'valid': int(v.size), 'nan': int(np.isnan(a).sum()),
         'min': float(v.min()), 'p5': float(np.percentile(v, 5)), 'p25': float(np.percentile(v, 25)), 'median': float(np.median(v)),
         'p75': float(np.percentile(v, 75)), 'p95': float(np.percentile(v, 95)), 'max': float(v.max())}
print(json.dumps(stats, indent=1))
json.dump(stats, open('dem-out/stats.json', 'w'), indent=1)
# เก็บเป็น int16 (ซม.) พร้อมพิกัด — ใช้ต่อในเซิร์ฟเวอร์/วิเคราะห์
cm = np.where(np.isfinite(a), np.round(a * 100), -32768).astype('<i2')
cm.tofile('dem-out/bkk_dtm_cm_int16.bin')
json.dump({'rows': a.shape[0], 'cols': a.shape[1], 'lat0': tr.f, 'lon0': tr.c, 'dlat': tr.e, 'dlon': tr.a, 'nodata': -32768,
           'unit': 'cm', 'source': 'DeltaDTM v1.1 (Pronk et al. 2024), CC BY 4.0, https://doi.org/10.4121/1da2e70f-6c4d-4b03-86bd-b53e789cc629'},
          open('dem-out/bkk_dtm_meta.json', 'w'), indent=1)
os.system('cp ' + tifs[0] + ' dem-out/ 2>/dev/null; ls -la dem-out')
