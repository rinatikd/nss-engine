import argparse
from .preview_v031 import export_preview

def main():
    p=argparse.ArgumentParser(description='Convert NSS v0.30 report into AutoCAD preview JSON')
    p.add_argument('--report',required=True)
    p.add_argument('--output',required=True)
    p.add_argument('--drawing',help='Optional expected DWG filename for cross-check')
    a=p.parse_args()
    result=export_preview(a.report,a.output,source_drawing=a.drawing)
    print(f"Wrote {len(result['routes'])} preview routes to {a.output}")
if __name__=='__main__': main()
