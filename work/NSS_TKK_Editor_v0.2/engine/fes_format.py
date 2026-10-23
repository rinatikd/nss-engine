STYLE='ФЭС'
HEIGHT=1.25
MASK_SCALE=1.1

def add_label(model,text,position,layer,rotation=0,centered=False):
    from ezdxf.enums import MTextEntityAlignment
    entity=model.add_mtext(text,dxfattribs=dict(layer=layer,style=STYLE,char_height=HEIGHT,insert=position,rotation=rotation,width=0,attachment_point=MTextEntityAlignment.MIDDLE_CENTER if centered else MTextEntityAlignment.TOP_LEFT))
    return entity

def style_leader(entity,style_handle,content=None):
    if not entity.context.mtext:raise ValueError('Only text MLEADER can be restyled')
    if content is not None:entity.context.mtext.default_content=content
    entity.dxf.text_style_handle=style_handle
    entity.context.mtext.style_handle=style_handle
    entity.context.char_height=HEIGHT
    entity.context.mtext.has_bg_fill=0
    entity.context.mtext.use_window_bg_color=0
    entity.context.mtext.bg_scale_factor=1.0
    entity.context.mtext.bg_transparency=0
    entity.dxf.color=7
