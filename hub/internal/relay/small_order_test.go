package relay

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
)

// 小阶点不能当端点编号：它们配上全零签名能通过宽松的签名校验。
func TestValidateEndpointIDRejectsSmallOrderPoints(t *testing.T) {
	identity := [32]byte{1}
	minusIdentity := [32]byte{0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f}
	order4 := [32]byte{} // y = 0：四阶点
	for name, pk := range map[string][32]byte{"identity": identity, "minus-identity": minusIdentity, "order-4": order4} {
		if err := ValidateEndpointID(pk); err == nil {
			t.Fatalf("%s 必须被拒绝", name)
		}
	}
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var ok [32]byte
	copy(ok[:], pub)
	if err := ValidateEndpointID(ok); err != nil {
		t.Fatalf("正常的公钥不得被拒绝: %v", err)
	}
}
