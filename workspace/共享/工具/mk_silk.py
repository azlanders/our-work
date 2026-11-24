import sys
import pilk
# 必须加 tencent=True（写入 0x02#!SILK_V3 腾讯头），否则手机 QQ 点开会秒结束听不到声音
pilk.encode(sys.argv[1], sys.argv[2], 24000, tencent=True)
print("silk ok (tencent=True)")
