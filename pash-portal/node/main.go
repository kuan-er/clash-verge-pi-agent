package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	anytls "github.com/anytls/sing-anytls"
	"github.com/anytls/sing-anytls/padding"
	"github.com/sagernet/sing/common/auth"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/common/uot"
)

type user struct {
	ID        string `json:"id"`
	Password  string `json:"password"`
	Enabled   bool   `json:"enabled"`
	ExpiresAt int64  `json:"expiresAt"`
}

type totals struct {
	Upload   uint64 `json:"upload"`
	Download uint64 `json:"download"`
}

type meter struct {
	up   atomic.Uint64
	down atomic.Uint64
}

type session struct {
	conn  net.Conn
	user  string
	ip    string
	users map[string]user
}

type contextKey struct{}

type server struct {
	mu       sync.Mutex
	users    map[string]user
	meters   map[string]*meter
	sessions map[*session]bool
	service  atomic.Pointer[anytls.Service]
	state    string
}

type quietLogger struct{}

func (quietLogger) Trace(...any)                         {}
func (quietLogger) Debug(...any)                         {}
func (quietLogger) Info(...any)                          {}
func (quietLogger) Warn(...any)                          {}
func (quietLogger) Error(...any)                         {}
func (quietLogger) Fatal(...any)                         {}
func (quietLogger) Panic(...any)                         {}
func (quietLogger) TraceContext(context.Context, ...any) {}
func (quietLogger) DebugContext(context.Context, ...any) {}
func (quietLogger) InfoContext(context.Context, ...any)  {}
func (quietLogger) WarnContext(context.Context, ...any)  {}
func (quietLogger) ErrorContext(context.Context, ...any) {}
func (quietLogger) FatalContext(context.Context, ...any) {}
func (quietLogger) PanicContext(context.Context, ...any) {}

func available(u user) bool {
	return u.Enabled && (u.ExpiresAt == 0 || u.ExpiresAt > time.Now().Unix())
}

func (s *server) update(users []user) error {
	next := make(map[string]user)
	credentials := make([]anytls.User, 0, len(users))
	for _, u := range users {
		if u.ID == "" || len(u.Password) < 24 {
			return fmt.Errorf("invalid user")
		}
		next[u.ID] = u
		if available(u) {
			credentials = append(credentials, anytls.User{Name: u.ID, Password: u.Password})
		}
	}
	service, err := anytls.NewService(anytls.ServiceConfig{
		Users: credentials, PaddingScheme: padding.DefaultPaddingScheme, Handler: s, Logger: quietLogger{},
	})
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.users = next
	for id := range next {
		if s.meters[id] == nil {
			s.meters[id] = &meter{}
		}
	}
	s.service.Store(service)
	for client := range s.sessions {
		if client.user == "" {
			continue
		}
		u, ok := next[client.user]
		if !ok || !available(u) || u.Password != client.users[client.user].Password {
			client.conn.Close()
		}
	}
	s.mu.Unlock()
	return nil
}

func publicAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsValid() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsUnspecified() && !ip.IsMulticast() && !ip.IsLinkLocalUnicast()
}

func resolvePublic(ctx context.Context, host string, port uint16) (netip.Addr, error) {
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return netip.Addr{}, err
	}
	for _, ip := range addresses {
		if publicAddress(ip) && !(ip.String() == "154.40.137.121" && port != 8443) {
			return ip.Unmap(), nil
		}
	}
	return netip.Addr{}, fmt.Errorf("destination unavailable")
}

type countedReader struct {
	io.Reader
	counter *atomic.Uint64
}

func (r countedReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.counter.Add(uint64(n))
	return n, err
}

type publicPacket struct {
	net.PacketConn
	meter *meter
}

func (p publicPacket) WriteTo(b []byte, addr net.Addr) (int, error) {
	a, ok := addr.(*net.UDPAddr)
	if !ok {
		return 0, fmt.Errorf("invalid UDP address")
	}
	ip, ok := netip.AddrFromSlice(a.IP)
	if !ok || !publicAddress(ip) || ip.Unmap().String() == "154.40.137.121" {
		return 0, fmt.Errorf("destination unavailable")
	}
	p.SetDeadline(time.Now().Add(90 * time.Second))
	n, err := p.PacketConn.WriteTo(b, addr)
	p.meter.up.Add(uint64(n))
	return n, err
}
func (p publicPacket) ReadFrom(b []byte) (int, net.Addr, error) {
	n, addr, err := p.PacketConn.ReadFrom(b)
	p.meter.down.Add(uint64(n))
	return n, addr, err
}

func (s *server) NewConnectionEx(ctx context.Context, conn net.Conn, source M.Socksaddr, destination M.Socksaddr, onClose N.CloseHandlerFunc) {
	defer conn.Close()
	id, ok := auth.UserFromContext[string](ctx)
	client, _ := ctx.Value(contextKey{}).(*session)
	if !ok || client == nil {
		return
	}
	s.mu.Lock()
	u, exists := s.users[id]
	if !exists || !available(u) || u.Password != client.users[id].Password {
		s.mu.Unlock()
		return
	}
	client.user = id
	client.conn.SetDeadline(time.Time{})
	m := s.meters[id]
	s.mu.Unlock()
	var remote net.Conn
	if destination.Fqdn == uot.MagicAddress || destination.Fqdn == uot.LegacyMagicAddress {
		packet, err := net.ListenPacket("udp", ":0")
		if err != nil {
			return
		}
		packet.SetDeadline(time.Now().Add(90 * time.Second))
		version := uot.Version
		if destination.Fqdn == uot.LegacyMagicAddress {
			version = uot.LegacyVersion
		}
		remote = uot.NewServerConn(publicPacket{packet, m}, version)
	} else {
		deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
		ip, err := resolvePublic(deadline, destination.AddrString(), destination.Port)
		if err != nil {
			cancel()
			return
		}
		remote, err = (&net.Dialer{}).DialContext(deadline, "tcp", net.JoinHostPort(ip.String(), strconv.Itoa(int(destination.Port))))
		cancel()
		if err != nil {
			return
		}
	}
	defer remote.Close()
	finished := make(chan struct{})
	if destination.Fqdn == uot.MagicAddress || destination.Fqdn == uot.LegacyMagicAddress {
		go func() { io.Copy(remote, conn); remote.Close(); close(finished) }()
		io.Copy(conn, remote)
	} else {
		go func() { io.Copy(remote, countedReader{conn, &m.up}); remote.Close(); close(finished) }()
		io.Copy(conn, countedReader{remote, &m.down})
	}
	conn.Close()
	remote.Close()
	<-finished
}

func (s *server) snapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	users := make(map[string]any)
	allIPs := make(map[string]bool)
	for id, m := range s.meters {
		ips := make(map[string]int)
		connections := 0
		for c := range s.sessions {
			if c.user == id {
				ips[c.ip]++
				allIPs[c.ip] = true
				connections++
			}
		}
		users[id] = map[string]any{"upload": m.up.Load(), "download": m.down.Load(), "ips": ips, "connections": connections}
	}
	return map[string]any{"users": users, "onlineIPs": len(allIPs), "timestamp": time.Now().UnixMilli(), "serverNetwork": networkStats(), "inboundIPs": inboundIPs()}
}

func networkStats() map[string]uint64 {
	result := map[string]uint64{"received": 0, "sent": 0}
	data, _ := os.ReadFile("/proc/net/dev")
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		name := strings.TrimSpace(parts[0])
		if name == "lo" || strings.HasPrefix(name, "tun") || strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "docker") {
			continue
		}
		fields := strings.Fields(parts[1])
		if len(fields) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(fields[0], 10, 64)
		tx, _ := strconv.ParseUint(fields[8], 10, 64)
		result["received"] += rx
		result["sent"] += tx
	}
	return result
}

func inboundIPs() map[string]any {
	ips := make(map[string]int)
	proxy := make(map[string]int)
	for _, file := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		data, _ := os.ReadFile(file)
		for _, line := range strings.Split(string(data), "\n")[1:] {
			fields := strings.Fields(line)
			if len(fields) < 4 || fields[3] != "01" {
				continue
			}
			local := strings.Split(fields[1], ":")
			peer := strings.Split(fields[2], ":")
			if len(local) != 2 || len(peer) != 2 {
				continue
			}
			port, _ := strconv.ParseUint(local[1], 16, 16)
			if port != 443 && port != 4443 && port != 8443 && port != 23522 {
				continue
			}
			hex := peer[0]
			bytes := make([]byte, len(hex)/2)
			for i := range bytes {
				value, _ := strconv.ParseUint(hex[i*2:i*2+2], 16, 8)
				bytes[i] = byte(value)
			}
			for i := 0; i < len(bytes); i += 4 {
				bytes[i], bytes[i+3] = bytes[i+3], bytes[i]
				bytes[i+1], bytes[i+2] = bytes[i+2], bytes[i+1]
			}
			ip := net.IP(bytes).String()
			if net.ParseIP(ip).IsLoopback() {
				continue
			}
			ips[ip]++
			if port == 443 || port == 4443 {
				proxy[ip]++
			}
		}
	}
	return map[string]any{"all": ips, "proxy": proxy}
}

func (s *server) save() error {
	s.mu.Lock()
	data := make(map[string]totals)
	for id, m := range s.meters {
		data[id] = totals{m.up.Load(), m.down.Load()}
	}
	s.mu.Unlock()
	encoded, err := json.Marshal(data)
	if err != nil {
		return err
	}
	p := filepath.Join(s.state, "node-totals.json")
	if err = os.WriteFile(p+".tmp", encoded, 0600); err != nil {
		return err
	}
	return os.Rename(p+".tmp", p)
}

func main() {
	state := os.Getenv("PASH_STATE_DIR")
	if state == "" {
		log.Fatal("PASH_STATE_DIR required")
	}
	os.MkdirAll(state, 0700)
	s := &server{state: state, users: map[string]user{}, meters: map[string]*meter{}, sessions: map[*session]bool{}}
	if data, err := os.ReadFile(filepath.Join(state, "node-totals.json")); err == nil {
		stored := map[string]totals{}
		if json.Unmarshal(data, &stored) != nil {
			log.Fatal("Invalid saved traffic counters")
		}
		for id, t := range stored {
			m := &meter{}
			m.up.Store(t.Upload)
			m.down.Store(t.Download)
			s.meters[id] = m
		}
	}
	users := []user{}
	if data, err := os.ReadFile(filepath.Join(state, "node-users.json")); err == nil {
		if json.Unmarshal(data, &users) != nil {
			log.Fatal("Invalid user configuration")
		}
	}
	if err := s.update(users); err != nil {
		log.Fatal(err)
	}
	certificate, err := tls.LoadX509KeyPair(os.Getenv("PASH_NODE_CERT"), os.Getenv("PASH_NODE_KEY"))
	if err != nil {
		log.Fatal("Unable to load node certificate")
	}
	address := os.Getenv("PASH_NODE_LISTEN")
	if address == "" {
		address = ":4443"
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		log.Fatal(err)
	}
	tlsConfig := &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}
	socketPath := filepath.Join(state, "node.sock")
	os.Remove(socketPath)
	control, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatal(err)
	}
	os.Chmod(socketPath, 0600)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.snapshot())
	})
	mux.HandleFunc("PUT /users", func(w http.ResponseWriter, r *http.Request) {
		var users []user
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1048576)).Decode(&users) != nil {
			http.Error(w, "invalid users", 400)
			return
		}
		if err := s.update(users); err != nil {
			http.Error(w, "invalid users", 400)
			return
		}
		w.WriteHeader(204)
	})
	go (&http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}).Serve(control)
	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				conn := tls.Server(raw, tlsConfig)
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(12 * time.Second))
				if conn.Handshake() != nil {
					return
				}
				conn.SetDeadline(time.Now().Add(12 * time.Second))
				ip, _, _ := net.SplitHostPort(conn.RemoteAddr().String())
				s.mu.Lock()
				client := &session{conn: conn, ip: ip, users: s.users}
				service := s.service.Load()
				s.sessions[client] = true
				s.mu.Unlock()
				defer func() { s.mu.Lock(); delete(s.sessions, client); s.mu.Unlock() }()
				ctx := context.WithValue(context.Background(), contextKey{}, client)
				service.NewConnection(ctx, conn, M.SocksaddrFromNet(conn.RemoteAddr()), nil)
			}()
		}
	}()
	go func() {
		for range time.Tick(time.Second) {
			if err := s.save(); err != nil {
				log.Print("Unable to save traffic counters")
			}
			s.mu.Lock()
			for client := range s.sessions {
				if client.user != "" && !available(s.users[client.user]) {
					client.conn.Close()
				}
			}
			s.mu.Unlock()
		}
	}()
	log.Print("Managed AnyTLS node ready")
	done := make(chan os.Signal, 1)
	signal.Notify(done, syscall.SIGINT, syscall.SIGTERM)
	<-done
	listener.Close()
	control.Close()
	if err := s.save(); err != nil {
		log.Print("Unable to save final traffic counters")
	}
}
