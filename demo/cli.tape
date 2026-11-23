# A scripted clip of agt's CLI on the demo workspace (no agents involved).
#   demo/setup-workspace.sh && vhs demo/cli.tape      → demo/out/cli.gif
Output demo/out/cli.gif

Set Shell "bash"
Set FontSize 18
Set Width 1400
Set Height 800
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type "cd /tmp/agt-demo && export PS1='$ ' && clear"
Enter
Show

Type "agt help stack"
Enter
Sleep 2.5s

Type "agt stack start"
Enter
Sleep 4s

Type "agt stack status"
Enter
Sleep 3s

Type "curl -s localhost:4102/"
Enter
Sleep 2s

Type "agt stack stop"
Enter
Sleep 2.5s
