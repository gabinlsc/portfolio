"""Génère la favicon (SVG, ICO, PNG) et la bannière 1500×500 dans branding/. Nécessite Pillow et fonttools.
Après modification : python3 tools/build-branding.py puis copier favicon.svg, favicon.ico, favicon-32.png et apple-touch-icon.png dans assets/_glsc/."""
import math, os
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FONTS = os.path.join(ROOT, "deploy/games/cards/fonts")
OUT = os.path.join(ROOT, "branding")
INK=(17,17,17); CREAM=(255,253,240)
C={"banana":(255,216,77),"mint":(123,224,173),"lilac":(195,166,255),"sky":(143,211,255),"coral":(255,148,120),"peach":(255,201,168)}
fred=lambda s: ImageFont.truetype(f"{FONTS}/fredoka-latin-700-normal.ttf", s)
grot=lambda s: ImageFont.truetype(f"{FONTS}/space-grotesk-latin-700-normal.ttf", s)

# ------------------------------------------------------------------ favicon
def tile(size, shadow=False, full_bleed=False):
    S=4; n=size*S
    im=Image.new("RGBA",(n,n),(0,0,0,0)); d=ImageDraw.Draw(im)
    if full_bleed:
        d.rectangle((0,0,n,n),fill=C["banana"]+(255,))
        box=(0,0,n,n)
    else:
        m=int(n*0.06); b=int(n*0.07); r=int(n*0.24)
        d.rounded_rectangle((m,m,n-m,n-m),r,fill=C["banana"]+(255,),outline=INK+(255,),width=b)
        box=(m,m,n-m,n-m)
    f=fred(int(n*0.5))
    tb=d.textbbox((0,0),"GL",font=f)
    tw,th=tb[2]-tb[0],tb[3]-tb[1]
    cx=(box[0]+box[2])/2; cy=(box[1]+box[3])/2
    d.text((cx-tw/2-tb[0], cy-th/2-tb[1]),"GL",font=f,fill=INK+(255,))
    return im.resize((size,size),Image.LANCZOS)

for s in (16,32,48,64,192,512):
    tile(s).save(f"{OUT}/favicon-{s}.png")
tile(180,full_bleed=True).convert("RGB").save(f"{OUT}/apple-touch-icon.png")
tile(512).save(f"{OUT}/favicon-512.png")
imgs=[tile(s) for s in (16,32,48)]
imgs[2].save(f"{OUT}/favicon.ico",sizes=[(16,16),(32,32),(48,48)],append_images=imgs[:2])

# SVG (lettres vectorisées : aucune dépendance à une police)
font=TTFont(f"{FONTS}/fredoka-latin-700-normal.ttf"); gs=font.getGlyphSet(); cmap=font.getBestCmap()
upm=font["head"].unitsPerEm
adv=0; bp=BoundsPen(gs); pos=[]
for ch in "GL":
    g=cmap[ord(ch)]; pos.append((g,adv)); adv+=font["hmtx"][g][0]
xs=[];ys=[]
for g,x in pos:
    b=BoundsPen(gs); gs[g].draw(b); xs+= [b.bounds[0]+x,b.bounds[2]+x]; ys+=[b.bounds[1],b.bounds[3]]
bx0,bx1,by0,by1=min(xs),max(xs),min(ys),max(ys)
k=64*0.5/(by1-by0)*1.0            # hauteur des lettres ≈ 50 % de la pastille (viewBox 64)
tx=32-(bx0+bx1)/2*k; ty=32+(by0+by1)/2*k
paths=""
for g,x in pos:
    pen=SVGPathPen(gs); tp=TransformPen(pen,(k,0,0,-k,tx+x*k,ty)); gs[g].draw(tp); paths+=pen.getCommands()
open(f"{OUT}/favicon.svg","w").write(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" rx="15" fill="#FFD84D" stroke="#111" stroke-width="4.5"/><path d="{paths}" fill="#111"/></svg>\n''')

# ------------------------------------------------------------------ bannière
def banner(W,H,name):
    S=2; w,h=W*S,H*S
    im=Image.new("RGBA",(w,h),CREAM+(255,)); d=ImageDraw.Draw(im)
    for y in range(0,h,22*S):
        for x in range(0,w,22*S):
            d.ellipse((x-1.2*S,y-1.2*S,x+1.2*S,y+1.2*S),fill=(0,0,0,20))
    u=h/500  # unité : tout est dessiné pour 500 px de haut
    def P(v): return int(v*u)
    def rr(box,r,fill,sh=10,bw=5):
        x0,y0,x1,y1=[P(v) for v in box]
        if sh: d.rounded_rectangle((x0+P(sh),y0+P(sh),x1+P(sh),y1+P(sh)),P(r),fill=INK)
        d.rounded_rectangle((x0,y0,x1,y1),P(r),fill=fill,outline=INK,width=P(bw))
    # cercles décoratifs
    d.ellipse((w-P(230),-P(150),w+P(120),P(200)),fill=C["coral"],outline=INK,width=P(6))
    d.ellipse((-P(150),h-P(230),P(210),h+P(110)),fill=C["mint"],outline=INK,width=P(6))
    # carte lilas
    cx0,cy0,cx1,cy1=P(110),P(70),w-P(110),h-P(70)
    d.rounded_rectangle((cx0+P(12),cy0+P(12),cx1+P(12),cy1+P(12)),P(34),fill=INK)
    d.rounded_rectangle((cx0,cy0,cx1,cy1),P(34),fill=C["lilac"],outline=INK,width=P(6))
    # texte
    left=cx0+P(56)
    # étiquette
    ff=grot(P(19)); label="GLSC.FR · RENNES"
    tw=d.textlength(label,font=ff)+P(36)
    d.rounded_rectangle((left+P(5),cy0+P(37),left+tw+P(5),cy0+P(37)+P(40)),P(20),fill=INK)
    d.rounded_rectangle((left,cy0+P(32),left+tw,cy0+P(72)),P(20),fill=C["sky"],outline=INK,width=P(4))
    d.text((left+P(18),cy0+P(41)),label,font=ff,fill=INK)
    # nom, « LESCOAT » surligné
    fn=fred(P(92)); y=cy0+P(92)
    n1="GABIN "; n2="LESCOAT"
    w1=d.textlength(n1,font=fn); w2=d.textlength(n2,font=fn)
    d.rounded_rectangle((left+w1-P(6),y+P(52),left+w1+w2+P(6),y+P(92)),P(8),fill=C["banana"])
    d.text((left,y),n1+n2,font=fn,fill=INK)
    # sous-titre
    d.text((left,y+P(110)),"Alternant développeur informatique",font=fred(P(31)),fill=INK)
    # puces
    x=left; by=cy0+P(278)
    for t,col in (("Java","coral"),("PHP","banana"),("Vue.js","mint"),("React","sky"),("Rust","peach"),("Linux",None)):
        fc=grot(P(23)); wd=d.textlength(t,font=fc)+P(34)
        d.rounded_rectangle((x+P(4),by+P(4),x+wd+P(4),by+P(46)),P(14),fill=INK)
        d.rounded_rectangle((x,by,x+wd,by+P(42)),P(14),fill=C[col] if col else (255,255,255),outline=INK,width=P(3))
        d.text((x+P(17),by+P(7)),t,font=fc,fill=INK)
        x+=wd+P(12)
    # pastille GL (inclinée) + étoile
    t=tile(P(150)*1,)  # RGBA propre, redessinée en grand pour la netteté
    T=Image.new("RGBA",(P(190),P(190)),(0,0,0,0)); td=ImageDraw.Draw(T)
    td.rounded_rectangle((P(34),P(34),P(34)+P(140),P(34)+P(140)),P(34),fill=INK)
    td.rounded_rectangle((P(24),P(24),P(24)+P(140),P(24)+P(140)),P(34),fill=C["banana"],outline=INK,width=P(6))
    f=fred(P(74)); tb=td.textbbox((0,0),"GL",font=f)
    td.text((P(24)+P(70)-(tb[0]+tb[2])/2,P(24)+P(70)-(tb[1]+tb[3])/2),"GL",font=f,fill=INK)
    T=T.rotate(8,resample=Image.BICUBIC,expand=True)
    im.alpha_composite(T,(cx1-P(235),cy0+P(30)))
    # étoile
    sx,sy,R=cx1-P(330),cy0+P(165),P(44)
    pts=[]
    for i in range(10):
        a=-math.pi/2+i*math.pi/5+0.25; r=R if i%2==0 else R*0.45
        pts.append((sx+r*math.cos(a),sy+r*math.sin(a)))
    d.polygon([(px+P(4),py+P(4)) for px,py in pts],fill=INK)
    d.polygon(pts,fill=C["banana"],outline=INK,width=P(4))
    # glsc.fr
    fb=grot(P(26)); lab="glsc.fr"; lw=d.textlength(lab,font=fb)+P(40)
    bx1,by1=w-P(24),h-P(24)
    d.rounded_rectangle((bx1-lw+P(6),by1-P(52)+P(6),bx1+P(6),by1+P(6)),P(16),fill=C["coral"])
    d.rounded_rectangle((bx1-lw,by1-P(52),bx1,by1),P(16),fill=INK)
    d.text((bx1-lw+P(20),by1-P(41)),lab,font=fb,fill=CREAM)
    im.convert("RGB").resize((W,H),Image.LANCZOS).save(f"{OUT}/{name}",optimize=True)

banner(1500,500,"banniere-1500x500.png")
print(sorted(os.listdir(OUT)))
