# demo/record.sh runs this tape, then encodes docs/demo.gif from the frames.
Output demo/frames/

Set Shell zsh
Set FontSize 16
Set Width 1260
Set Height 760
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type "export PS1='$ ' && alias boo='./node_modules/.bin/tsx --tsconfig demo/tsconfig.json demo/demo.tsx' && clear"
Enter
Sleep 500ms
Show

Type "boo --watch"
Sleep 600ms
Enter
Sleep 19s
Enter
Sleep 1.8s
Down@400ms 4
Sleep 0.6s
Enter
Sleep 1.8s
Right
Sleep 1.2s
Type "r"
Sleep 1.2s
Type "a"
Sleep 1.2s
Enter
Sleep 4s
Escape
Sleep 0.8s
Up@400ms 4
Sleep 0.8s
Type "a"
Sleep 1.5s
Type "f"
Sleep 2.5s
Enter
Sleep 3s
