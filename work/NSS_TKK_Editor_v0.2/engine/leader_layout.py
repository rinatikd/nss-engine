"""Conservative XY text-box placement. Leader arrows may touch their own well."""
import math
from shapely.geometry import Point,LineString,box
from shapely.ops import unary_union
from shapely.prepared import prep
from shapely.affinity import rotate
from ezdxf.fonts import fonts
from ezdxf.tools.text_size import estimate_mtext_extents
from ezdxf.render.mleader import make_mtext
FONT=fonts.make_font('isocpeui.ttf',cap_height=1.25)

def text_dimensions(text):
    lines=text.replace('\\P','\n').splitlines() or ['']
    return max(FONT.text_width(s) for s in lines)*1.15+.25,1.25*(1+1.667*(len(lines)-1))+.2

def caption_box(label):
    width,height=text_dimensions(label['text']);x,y=label['xyz'][:2]
    rect=box(x-width/2-.5,y-height/2-.5,x+width/2+.5,y+height/2+.5)
    return rotate(rect,label.get('rotation',0)*180/math.pi,origin=(x,y))

def place_leaders(wells,routes,captions):
    paths=[LineString([p[:2] for p in route['points']]) for route in routes]
    network=unary_union(paths);route_obstacle=network.buffer(.7)
    well_obstacle=unary_union([Point(w['xyz'][:2]).buffer(max(1.0,w.get('radius',.315)+.5)) for w in wells])
    caption_obstacle=unary_union([caption_box(c) for c in captions]) if captions else Point().buffer(0)
    obstacle=prep(unary_union([route_obstacle,well_obstacle,caption_obstacle]))
    occupied=[];result=[]
    def density(w):return sum(math.dist(w['xyz'][:2],v['xyz'][:2])<20 for v in wells)
    ordered=sorted(wells,key=lambda w:(-len(w['text']),-density(w),w['key']))
    for well in ordered:
        width,height=text_dimensions(well['text']);x,y=well['xyz'][:2];best=None
        for radius in (4,6,8,10,14,18,24,32,45,60,85,120):
            for degree in range(0,360,15):
                angle=math.radians(degree);cx=x+radius*math.cos(angle);cy=y+radius*math.sin(angle)
                rect=box(cx-width/2-.65,cy-height/2-.65,cx+width/2+.65,cy+height/2+.65)
                if obstacle.intersects(rect) or any(rect.intersects(other) for other in occupied):continue
                endpoint=(cx-width/2-.35,cy) if cx>=x else (cx+width/2+.35,cy)
                stem=LineString([(x,y),endpoint]);trimmed=LineString([stem.interpolate(min(1,stem.length/2)),Point(endpoint)])
                intersection=trimmed.intersection(network)
                crossings=0 if intersection.is_empty else len(intersection.geoms) if hasattr(intersection,'geoms') else 1
                text_crossings=sum(1 for old in occupied if stem.intersects(old))
                score=radius+crossings*100+text_crossings*200
                if best is None or score<best[0]:best=(score,rect,cx,cy,radius)
            if best is not None and best[0]<=radius:break
        if best is None:raise ValueError('No collision-free text position for '+well['key'])
        _,rect,cx,cy,radius=best;occupied.append(rect)
        z=well['xyz'][2] if len(well['xyz'])>2 else 0
        result.append(dict(key=well['key'],text=well['text'],target=well['xyz'],insert=[cx-width/2,cy+height/2,z],side='left' if cx>=x else 'right',box=list(rect.bounds),offset_m=radius,layer=well['layer'],reference=well.get('reference',False)))
    return result,dict(text_route_collisions=sum(rect.intersects(route_obstacle) for rect in occupied),text_well_collisions=sum(rect.intersects(well_obstacle) for rect in occupied),text_caption_collisions=sum(rect.intersects(caption_obstacle) for rect in occupied),text_text_collisions=sum(occupied[i].intersects(occupied[j]) for i in range(len(occupied)) for j in range(i)),max_offset_m=max((item['offset_m'] for item in result),default=0),measurement='isocpeui TTF advances plus conservative padding; AutoCAD rendering pending')

def build_mleader(model,item,style_name='NSS_FES_WELLS'):
    from ezdxf.math import Vec2,UCS
    from ezdxf.render.mleader import ConnectionSide,HorizontalConnection,TextAlignment
    from fes_format import style_leader,STYLE
    doc=model.doc
    from fes_format import STYLE
    if STYLE not in doc.styles: doc.styles.new(STYLE)
    if style_name not in doc.mleader_styles:
        style=doc.mleader_styles.duplicate_entry('Standard',style_name)
        style.set_mtext_style(STYLE);style.dxf.char_height=1.25
        style.dxf.dogleg_length=1.2;style.dxf.landing_gap_size=.35
    style=doc.mleader_styles.get(style_name)
    style.dxf.leader_lineweight=9
    builder=model.add_multileader_mtext(style_name,dxfattribs=dict(layer=item['layer'],color=7,lineweight=9))
    builder.set_content(item['text'],char_height=1.25,style=STYLE,alignment=TextAlignment.left)
    builder.set_connection_properties(landing_gap=.35,dogleg_length=1.2)
    builder.set_connection_types(left=HorizontalConnection.middle_of_text,right=HorizontalConnection.middle_of_text)
    builder.set_arrow_properties(size=.35)
    builder.add_leader_line(ConnectionSide.left if item['side']=='left' else ConnectionSide.right,[Vec2(item['target'][:2])])
    z=item['target'][2] if len(item['target'])>2 else 0
    builder.build(Vec2(item['insert'][:2]),ucs=UCS(origin=(0,0,z)))
    entity=builder.multileader;style_leader(entity,doc.styles.get(STYLE).dxf.handle)
    return entity
