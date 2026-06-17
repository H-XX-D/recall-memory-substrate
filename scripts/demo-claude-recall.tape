# VHS tape → assets/recall-claude-demo.mp4  (render: `vhs scripts/demo-claude-recall.tape`)
# A shareable cast of Claude Code + Recall keeping durable memory across sessions.
Output assets/recall-claude-demo.mp4

Require recall
Require python3

Set Shell bash
Set FontSize 18
Set Width 1480
Set Height 940
Set Padding 28
Set Theme "Dracula"

Hide
Type "cd ~/Recall-GitHub-Clean && clear"
Enter
Sleep 800ms
Show

Type "./scripts/demo-claude-recall-cast.sh"
Sleep 700ms
Enter
Sleep 31s
