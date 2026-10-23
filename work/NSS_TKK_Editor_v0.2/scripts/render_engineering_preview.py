"""Raster QA of the exact standalone SVG panels embedded in REVIEW_29.html."""
import argparse
import re
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFont


def render(source, numbers, out):
    markup=source.read_text(encoding='utf8')
    panels=re.findall(r'<svg\b.*?</svg>',markup,flags=re.S)
    assert len(panels)==29
    result=Image.new('RGB',(1280,1400),'#edf1f5')
    heading=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',25)
    for index,number in enumerate(numbers):
        root=ET.fromstring(panels[number-1]);_,_,size,_=map(float,root.attrib['viewBox'].split())
        scale=600/size
        panel=Image.new('RGB',(600,600),'white');draw=ImageDraw.Draw(panel)
        def xy(element, a, b):return float(element.attrib[a])*scale,float(element.attrib[b])*scale
        for element in root:
            a=element.attrib; kind=element.tag
            width=max(1,round(float(a.get('stroke-width',.1))*scale))
            color=a.get('stroke','#222')
            if kind=='polyline':
                points=[tuple(float(x)*scale for x in pair.split(',')) for pair in a['points'].split()]
                draw.line(points,fill=color,width=width)
            elif kind=='rect' and 'x' in a:
                x,y=xy(element,'x','y');w=float(a['width'])*scale;h=float(a['height'])*scale
                draw.rectangle((x,y,x+w,y+h),fill=a.get('fill','white'))
            elif kind=='path':
                match=re.fullmatch(r'M([\d.]+) ([\d.]+)h([\d.]+)',a['d'])
                assert match, a['d']
                x,y,w=map(float,match.groups())
                draw.line((x*scale,y*scale,(x+w)*scale,y*scale),fill=color,width=width)
            elif kind=='circle':
                x,y=xy(element,'cx','cy');r=float(a['r'])*scale
                draw.ellipse((x-r,y-r,x+r,y+r),outline=color,width=width,fill=None if a.get('fill')=='none' else a.get('fill'))
            elif kind=='line':
                x1,y1=xy(element,'x1','y1');x2,y2=xy(element,'x2','y2')
                if 'stroke-dasharray' in a:
                    for j in range(0,20,2):
                        draw.line((x1+(x2-x1)*j/20,y1+(y2-y1)*j/20,x1+(x2-x1)*(j+1)/20,y1+(y2-y1)*(j+1)/20),fill=color,width=width)
                else:draw.line((x1,y1,x2,y2),fill=color,width=width)
            elif kind=='text':
                x,y=xy(element,'x','y');font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',max(7,round(float(a['font-size'])*scale)))
                # SVG text baseline is at y; Pillow's ls anchor uses that same baseline.
                text=''.join(element.itertext())
                if len(element):text=''.join(child.tail or '' for child in element)
                draw.text((x,y),text,fill=a.get('fill','#222'),font=font,anchor='ls')
        x=20+(index%2)*640;y=65+(index//2)*690
        result.paste(panel,(x,y))
        ImageDraw.Draw(result).text((x,y-42),f'R{number:02d} · исходный план XY',fill='#253549',font=heading)
    result.save(out)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('source',type=Path);p.add_argument('out',type=Path)
    a=p.parse_args();render(a.source,[2,5,17,26],a.out)
