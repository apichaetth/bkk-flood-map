#!/data/data/com.termux/files/usr/bin/bash
# ติดตั้งตัวดึงเซ็นเซอร์ กทม. บนมือถือ Android (แอป Termux + Termux:Boot จาก F-Droid)
# ใช้: bash termux-setup.sh   (จะถาม token ครั้งเดียว แล้วรันเองทุกครั้งที่เปิดเครื่อง)
set -e
pkg install -y nodejs-lts curl
mkdir -p ~/bma ~/.termux/boot
curl -fsSL https://raw.githubusercontent.com/apichaetth/bkk-flood-map/main/scripts/bma-fetch.mjs -o ~/bma/bma-fetch.mjs
if [ ! -f ~/bma/.env ]; then
  read -rsp "วาง GH_TOKEN แล้วกด Enter: " T; echo
  printf 'GH_TOKEN=%s\n' "$T" > ~/bma/.env; chmod 600 ~/bma/.env
fi
cat > ~/.termux/boot/bma.sh <<'B'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
set -a; . ~/bma/.env; set +a
cd ~/bma && exec node bma-fetch.mjs --loop 15 >> ~/bma/log.txt 2>&1
B
chmod +x ~/.termux/boot/bma.sh
echo "ทดสอบดึง 1 ครั้ง:"; node ~/bma/bma-fetch.mjs --dry
echo "เสร็จ: รีสตาร์ทมือถือ หรือรัน ~/.termux/boot/bma.sh & เพื่อเริ่มทำงาน · ดูผล: tail ~/bma/log.txt"
