"""Build the dashboard's public, offline route illustration from reference files.

Inputs: OurAirports airports.csv and Natural Earth ne_110m_admin_0_countries.geojson.
Neither input contains participant/device location. No flight-booking lookup.
"""
import argparse,csv,json,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--airports',type=Path,required=True);p.add_argument('--world',type=Path,required=True);p.add_argument('--out',type=Path,default=Path('dashboard/public/reference/route-reference.json'));a=p.parse_args()
airports=[]
with a.airports.open(newline='') as f:
 for r in csv.DictReader(f):
  if r['iata_code'] and r['type'] in ('large_airport','medium_airport','small_airport'):
   airports.append({'code':r['iata_code'],'icao':r.get('icao_code') or r.get('gps_code') or r['ident'],'name':r['name'],'city':r['municipality'],'x':round(float(r['longitude_deg']),4),'y':round(float(r['latitude_deg']),4)})
land=[]
for feature in json.loads(a.world.read_text())['features']:
 geometry=feature['geometry'];polys=geometry['coordinates'] if geometry['type']=='MultiPolygon' else [geometry['coordinates']]
 for poly in polys:
  ring=poly[0];parts=[];previous=None
  for lng,lat,*_ in ring:
   command='M' if previous is None or abs(previous-lng)>180 else 'L'
   parts.append(f'{command}{lng+180:.2f},{90-lat:.2f}');previous=lng
  land.append(' '.join(parts)+' Z')
result={'airports':airports,'land':land,'sources':{'airports':'https://ourairports.com/data/','basemap':'https://www.naturalearthdata.com/','airportsSha256':hashlib.sha256(a.airports.read_bytes()).hexdigest(),'worldSha256':hashlib.sha256(a.world.read_bytes()).hexdigest()},'meaning':'Public airport reference coordinates, not device GPS or a recorded flight path.'}
a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(json.dumps(result,separators=(',',':'))+'\n')
print(json.dumps({'airports':len(airports),'landParts':len(land),'bytes':a.out.stat().st_size}))
