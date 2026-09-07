// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * LOKOVault — ERC-721 Treasury NFT
 * Robinhood Chain (chainId 4663)
 *
 * Singleton NFT (max supply 1) with EIP-6551 Token Bound Account.
 * NFT holder controls the treasury TBA that receives 10% of all LP fee collects.
 * Fee split is configurable from 0% to 20% (hard limit enforced on-chain).
 */

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC721 {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    function balanceOf(address owner) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function approve(address to, uint256 tokenId) external;
    function getApproved(uint256 tokenId) external view returns (address);
    function setApprovalForAll(address operator, bool approved) external;
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
}

interface IERC721Metadata {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

interface IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

interface IERC6551Registry {
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address);

    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address);
}

library Strings {
    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}

library Base64 {
    string internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function encode(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";
        string memory table = TABLE;
        uint256 encodedLen = 4 * ((data.length + 2) / 3);
        string memory result = new string(encodedLen + 32);
        assembly {
            let tablePtr := add(table, 1)
            let resultPtr := add(result, 32)
            for { let i := 0 } lt(i, mload(data)) { } {
                i := add(i, 3)
                let input := and(mload(add(data, i)), 0xffffff)
                let out := mload(add(tablePtr, and(shr(18, input), 0x3F)))
                out := shl(8, out)
                out := add(out, and(mload(add(tablePtr, and(shr(12, input), 0x3F))), 255))
                out := shl(8, out)
                out := add(out, and(mload(add(tablePtr, and(shr(6, input), 0x3F))), 255))
                out := shl(8, out)
                out := add(out, and(mload(add(tablePtr, and(input, 0x3F))), 255))
                out := shl(224, out)
                mstore(resultPtr, out)
                resultPtr := add(resultPtr, 4)
            }
            switch mod(mload(data), 3)
            case 1 { mstore(sub(resultPtr, 2), shl(240, 0x3d3d)) }
            case 2 { mstore(sub(resultPtr, 1), shl(248, 0x3d)) }
            mstore(result, encodedLen)
        }
        return result;
    }
}

contract TreasuryNFT is IERC165, IERC721, IERC721Metadata {
    using Strings for uint256;

    // ── State ─────────────────────────────────────────────────────────────────
    string public override name = "LOKOVault";
    string public override symbol = "LKVAULT";

    address public owner;
    bool public paused;

    uint256 public feeSplitPct = 10;    // default 10%
    uint256 public constant FEE_SPLIT_MAX = 20; // hard limit

    address public tbaAddress; // set after createAccount

    // EIP-6551
    address public constant REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address public implementation; // TreasuryAccount address

    // ERC-721 storage
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    bool private _minted;

    // ── Events ─────────────────────────────────────────────────────────────────
    event TreasuryCreated(uint256 indexed tokenId, address tba);
    event FeeSplitUpdated(uint256 oldPct, uint256 newPct);
    event Paused(bool paused);

    // ── Modifiers ──────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    // ── Constructor ────────────────────────────────────────────────────────────
    constructor(address _implementation) {
        owner = msg.sender;
        implementation = _implementation;
    }

    // ── Mint ───────────────────────────────────────────────────────────────────
    function mint(address to) external onlyOwner {
        require(!_minted, "Already minted");
        _minted = true;

        _owners[1] = to;
        _balances[to]++;
        emit Transfer(address(0), to, 1);

        // Create TBA via EIP-6551 registry
        tbaAddress = IERC6551Registry(REGISTRY).createAccount(
            implementation,
            bytes32(0),
            block.chainid,
            address(this),
            1
        );

        emit TreasuryCreated(1, tbaAddress);
    }

    // ── Fee split ──────────────────────────────────────────────────────────────
    function setFeeSplitPct(uint256 pct) external onlyOwner {
        require(pct <= FEE_SPLIT_MAX, "Max 20%");
        emit FeeSplitUpdated(feeSplitPct, pct);
        feeSplitPct = pct;
    }

    // ── Emergency ─────────────────────────────────────────────────────────────
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    // ── TokenURI (on-chain SVG) ────────────────────────────────────────────────
    function tokenURI(uint256 tokenId) external view override returns (string memory) {
        require(_owners[tokenId] != address(0), "Not minted");
        string memory svg = _buildSVG();
        string memory svgBase64 = Base64.encode(bytes(svg));
        string memory json = string(abi.encodePacked(
            '{"name":"LOKOVault #1",',
            '"description":"LOKOVault - LP fee treasury on Robinhood Chain. NFT holder controls all accumulated fees. ',
            Strings.toString(feeSplitPct),
            '% of every LP collect flows here automatically.",',
            '"image":"data:image/svg+xml;base64,', svgBase64, '",',
            '"attributes":[',
            '{"trait_type":"Protocol","value":"Uniswap V3/V4"},',
            '{"trait_type":"Chain","value":"Robinhood Chain"},',
            '{"trait_type":"Chain ID","value":"4663"},',
            '{"trait_type":"Type","value":"Treasury"},',
            '{"trait_type":"Fee Split","value":"', Strings.toString(feeSplitPct), '%"}',
            ']}'
        ));
        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(bytes(json))
        ));
    }

    function _buildSVG() internal view returns (string memory) {
        string memory pct = Strings.toString(feeSplitPct);
        return string(abi.encodePacked(
            '<svg width="680" height="680" viewBox="0 0 680 680" xmlns="http://www.w3.org/2000/svg">',
            '<rect x="40" y="40" width="600" height="600" rx="32" fill="#0f172a"/>',
            '<rect x="60" y="60" width="560" height="560" rx="24" fill="#1e293b"/>',
            '<circle cx="100" cy="100" r="6" fill="#3b82f6" opacity="0.6"/>',
            '<circle cx="580" cy="100" r="6" fill="#3b82f6" opacity="0.6"/>',
            '<circle cx="100" cy="580" r="6" fill="#3b82f6" opacity="0.6"/>',
            '<circle cx="580" cy="580" r="6" fill="#3b82f6" opacity="0.6"/>',
            '<rect x="190" y="180" width="300" height="280" rx="16" fill="#1e3a5f" stroke="#2d5a8e" stroke-width="2"/>',
            '<circle cx="340" cy="310" r="100" fill="#162032" stroke="#3b82f6" stroke-width="3"/>',
            '<circle cx="340" cy="310" r="85" stroke="#2563eb" stroke-width="1.5" fill="none" opacity="0.6"/>',
            '<circle cx="340" cy="310" r="65" stroke="#1d4ed8" stroke-width="1" fill="none" opacity="0.4"/>',
            '<line x1="340" y1="225" x2="340" y2="395" stroke="#3b82f6" stroke-width="1.5" opacity="0.5"/>',
            '<line x1="255" y1="310" x2="425" y2="310" stroke="#3b82f6" stroke-width="1.5" opacity="0.5"/>',
            '<line x1="280" y1="250" x2="400" y2="370" stroke="#3b82f6" stroke-width="1" opacity="0.3"/>',
            '<line x1="400" y1="250" x2="280" y2="370" stroke="#3b82f6" stroke-width="1" opacity="0.3"/>',
            '<circle cx="340" cy="310" r="18" fill="#1d4ed8" stroke="#60a5fa" stroke-width="2"/>',
            '<circle cx="340" cy="310" r="8" fill="#93c5fd"/>',
            '<path d="M390 300 Q410 300 410 310 Q410 320 390 320" stroke="#60a5fa" stroke-width="3" fill="none" stroke-linecap="round"/>',
            '<circle cx="220" cy="210" r="8" fill="#0f2744" stroke="#2563eb" stroke-width="1.5"/>',
            '<circle cx="460" cy="210" r="8" fill="#0f2744" stroke="#2563eb" stroke-width="1.5"/>',
            '<circle cx="220" cy="430" r="8" fill="#0f2744" stroke="#2563eb" stroke-width="1.5"/>',
            '<circle cx="460" cy="430" r="8" fill="#0f2744" stroke="#2563eb" stroke-width="1.5"/>',
            '<ellipse cx="160" cy="274" rx="22" ry="10" fill="#fbbf24" stroke="#d97706" stroke-width="1.5"/>',
            '<text x="160" y="278" text-anchor="middle" font-size="10" fill="#78350f" font-weight="700" font-family="sans-serif">$</text>',
            '<ellipse cx="520" cy="344" rx="22" ry="10" fill="#fbbf24" stroke="#d97706" stroke-width="1.5"/>',
            '<text x="520" y="348" text-anchor="middle" font-size="10" fill="#78350f" font-weight="700" font-family="sans-serif">$</text>',
            '<rect x="430" y="170" width="80" height="30" rx="15" fill="#1d4ed8" stroke="#60a5fa" stroke-width="1.5"/>',
            '<text x="470" y="191" text-anchor="middle" font-size="13" fill="#bfdbfe" font-weight="700" font-family="sans-serif">', pct, '%</text>',
            '<rect x="170" y="170" width="100" height="24" rx="12" fill="#0f2744" stroke="#2563eb" stroke-width="1"/>',
            '<text x="220" y="187" text-anchor="middle" font-size="11" fill="#93c5fd" font-family="sans-serif">Chain 4663</text>',
            '<text x="340" y="510" text-anchor="middle" font-size="28" fill="#e2e8f0" font-weight="700" font-family="sans-serif">LOKOVault</text>',
            '<text x="340" y="540" text-anchor="middle" font-size="13" fill="#64748b" font-family="sans-serif">EIP-6551 Token Bound Account</text>',
            '<text x="340" y="570" text-anchor="middle" font-size="11" fill="#475569" font-family="sans-serif">#1 Robinhood Chain</text>',
            '<line x1="200" y1="590" x2="480" y2="590" stroke="#1e3a5f" stroke-width="1"/>',
            '</svg>'
        ));
    }

    // ── ERC-721 ───────────────────────────────────────────────────────────────
    function balanceOf(address _owner) external view override returns (uint256) {
        return _balances[_owner];
    }

    function ownerOf(uint256 tokenId) external view override returns (address) {
        address _owner = _owners[tokenId];
        require(_owner != address(0), "Not minted");
        return _owner;
    }

    function approve(address to, uint256 tokenId) external override whenNotPaused {
        address _owner = _owners[tokenId];
        require(msg.sender == _owner || _operatorApprovals[_owner][msg.sender], "Not authorized");
        _tokenApprovals[tokenId] = to;
        emit Approval(_owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view override returns (address) {
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external override {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address _owner, address operator) external view override returns (bool) {
        return _operatorApprovals[_owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public override whenNotPaused {
        address _owner = _owners[tokenId];
        require(
            msg.sender == _owner ||
            msg.sender == _tokenApprovals[tokenId] ||
            _operatorApprovals[_owner][msg.sender],
            "Not authorized"
        );
        require(from == _owner, "Wrong from");
        require(to != address(0), "Zero address");
        delete _tokenApprovals[tokenId];
        _balances[from]--;
        _balances[to]++;
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external override {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public override {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            bytes4 retval = IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data);
            require(retval == IERC721Receiver.onERC721Received.selector, "Unsafe recipient");
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IERC165).interfaceId ||
               interfaceId == type(IERC721).interfaceId ||
               interfaceId == type(IERC721Metadata).interfaceId;
    }
}
