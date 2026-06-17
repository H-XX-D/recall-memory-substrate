Output assets/recall-demo.gif
Output assets/recall-demo.mp4
Set Shell bash
Set FontSize 15
Set Width 1180
Set Height 1000
Set Padding 22
Set Theme "Dracula"

Hide
Type "export RECALL=${RECALL:-recall}; npm run build >/dev/null 2>&1; clear"
Enter
Sleep 9s
Show

Type "DEMO_PACE=1 ./scripts/demo-cross-session.sh"
Sleep 700ms
Enter
Sleep 22s
