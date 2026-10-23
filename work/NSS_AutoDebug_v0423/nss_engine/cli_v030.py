import argparse
from .workflow_v030 import run,write_report

def main():
    parser=argparse.ArgumentParser(description='NSS v0.30 read-only conceptual workflow')
    parser.add_argument('--snapshot',required=True)
    parser.add_argument('--plan',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--rules')
    args=parser.parse_args()
    write_report(run(args.snapshot,args.plan,args.rules),args.output)
    print('Report saved:',args.output)
if __name__=='__main__':main()
